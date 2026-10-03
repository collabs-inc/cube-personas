# Personas

Personas is a long-running agent that directs Claude Code and Codex workers on your machine. It is a standalone app that installs as a Cube app: Cube reads `cube.json`, runs the install command, and starts the server, which listens on `127.0.0.1` only.

You talk to a persona in a conversation tile. The persona runs as an ACP agent (Claude Code or Codex) in its own context folder, and it has a small tool server it reaches over MCP to start workers, send them text, and stop them. Each worker is a real Claude Code or Codex terminal on this machine. When a worker finishes a turn, its report is queued and delivered to the persona with its next prompt, so a busy persona is never interrupted. Conversations, reports and worker terminals survive page reloads. A restart of the server resumes each persona's conversation and its workers: a turn that was running is lost and reported as interrupted, and a worker that never finished a turn comes back idle.

## Install in Cube

In Cube, open Apps, choose Install from a git URL, and enter `https://github.com/collabs-inc/cube-personas`. Cube runs `npm ci && npm run build` and then `node dist/server.js`.

## Run outside Cube (development)

```bash
npm ci && npm run build && PERSONAS_STATE_DIR="$(mktemp -d)" PORT=4870 node dist/server.js
```

`npm start` runs an already built server (`node dist/server.js`). Then open `http://127.0.0.1:4870`. Use a scratch state folder like this whenever the app may also be installed in Cube: only one server may use a state folder at a time, and a second one exits with "Another Personas server is using this state folder." Other commands:

- `npm test` runs the unit tests (vitest, with happy-dom for the UI).
- `npm run test:e2e` runs the end-to-end test: the built server (it builds first if `dist` is stale) on real processes with fake agents, through a full spawn, report, restart and crash recovery.
- `npm run typecheck` runs `tsc --noEmit`.

Environment variables:

- `PORT` is the port to listen on. It defaults to 4870 only for development; the server always binds `127.0.0.1`.
- `PERSONAS_STATE_DIR` sets the state directory.
- `XDG_STATE_HOME` is used when `PERSONAS_STATE_DIR` is unset.
- `PERSONAS_ALLOWED_HOSTS` adds comma-separated `host[:port]` values to the addresses the page may be reached at (loopback names and `*.cube.site` are always allowed).
- `PERSONAS_ADAPTER_CLAUDE` and `PERSONAS_ADAPTER_CODEX` name an executable to use in place of the pinned adapters. They exist for tests only.

## Where state lives

- The state directory is `$PERSONAS_STATE_DIR` if set, else `$XDG_STATE_HOME/cube-personas` if `XDG_STATE_HOME` is set, else `~/.local/state/cube-personas`. It is never inside the app's own folder. It holds the personas, conversations, reports and the secret that signs MCP tickets. A state file that cannot be parsed is renamed `<name>.corrupt` and the app continues without it.
- Each persona's context folder is `~/.cube/personas/<personaId>/`, seeded with an `AGENTS.md` and an empty `notes/`. Existing files are never overwritten.

## What it reads and runs

There are no caps or guardrails.

- Workers run Claude Code with `--dangerously-skip-permissions` and Codex with `--dangerously-bypass-approvals-and-sandbox`. They never ask before editing files or running commands, and they have your user's full access to this machine.
- The persona itself runs in its harness's permissive mode: `bypassPermissions` for Claude, `agent-full-access` for Codex.
- Nothing limits how many workers a persona starts or how long they run.
- Workers are found as `claude` and `codex` on `PATH`. `opencode` cannot be a worker, because it runs no hook to report through.
- The page can read files, and open HTML artifacts, under the repositories listed for a persona, its workers' git checkouts and its context folder. That list is the page's to edit, so it is a guard against mistakes rather than against the page; the filesystem root and the home folder itself are refused as entries.
- The MCP endpoint (`POST /mcp?persona=<id>`) accepts only loopback peers, refuses any request with an `Origin` header, and requires a per-launch bearer ticket.

## Design

One Node server (`src/server`) serves the page (`src/web`, React) and a WebSocket at `/ws` that carries the page's requests and the server's events.

- **Personas.** Each persona is an ACP adapter (`claude-agent-acp` or `codex-acp`) on plain stdio pipes, started in the persona's context folder. Every JSON-RPC message in either direction is appended to the persona's record log, one JSON line each, numbered by `seq`; a page opening the conversation gets the log's recent window and then every new record as it is written, and a page reconnecting asks only for what follows the last `seq` it holds. The adapter's session id is saved, so a restart resumes the same session with `session/load`.
- **Workers.** Each worker is the real `claude` or `codex` in a pty, launched with an attention hook: at the end of every turn the hook writes a small JSON file into a spool folder in the state directory. The server turns that file into a report (the turn's last message, capped at 4096 bytes), and a pty exit into an `exited` report. The page attaches to a worker's terminal and gets its trailing 256 KiB of output.
- **Delivery.** Reports are stored until the persona acknowledges them. A report rides on the person's next prompt when the persona is busy, or wakes an idle persona with a prompt of its own; an unacknowledged report is offered again on a backoff of 1 s doubling to 30 s.
- **Tools.** The persona reaches the server's MCP endpoint (`POST /mcp`) with a bearer ticket bound to its current launch, and uses it to list repositories, spawn, check, message, list and stop workers, and acknowledge reports (any call may carry `ack`).
- **Processes.** Every adapter and worker leads its own process group. The server ends them all on SIGTERM, SIGHUP, SIGINT or a crash, records each child's pid and command line, and on start ends any that a previous run left behind (only while the recorded command line still matches). One server uses a state folder at a time.

## Known gaps

- A turn running when the server stops is lost and reported as interrupted.
- A conversation tile shows only the most recent part of a long conversation (its last 5000 records or 4 MiB, whichever is smaller). The full log stays on disk in the state directory; there is no way to scroll back past that window in the tile.
- A retried `spawn_agent` can start a second worker.
- Nothing caps how many workers a persona starts or how long it runs.
- The tile does not follow Cube's own theme when Cube is set against the system's; an app tile is not told the theme.
- Typing into a worker yourself is invisible to its persona.
- Cube itself also has a built-in Personas feature, behind a flag. It and this app both use `~/.cube/personas/`; their ids never collide, but a person running both sees two sets of personas.
- The adapters are pinned; a newer `claude` or `codex` that changes its hook payloads degrades reports to `messageUnavailable` until the app is updated.
- The conversation's model and mode settings are shown but cannot be changed from the tile.
- Only images can be attached in the composer.
- A Codex worker can occasionally report a turn the person typed.
- The persona's stored adapter session is never silently replaced. If it cannot be loaded, Restart keeps trying and the persona stays stopped while that fails.

## Manual acceptance checklist

Automated tests use fake agents. Before a release, check these by hand against the real tools and record the result of each.

- [ ] The tile appears and works on screen in Cube desktop.
- [ ] The tile appears and works in Cube web.
- [ ] A plain browser tab at the app's `cube.site` address loads and works.
- [ ] Claude Code as the persona: record the `claude` version and the adapter argv, send a prompt, and confirm in the server log that `tools/list` reached `/mcp`.
- [ ] Claude Code as a worker: record the version and argv, start one from the persona, and confirm its report reaches the persona.
- [ ] Codex as the persona: record the `codex` version and the adapter argv, send a prompt, and confirm in the server log that `tools/list` reached `/mcp`.
- [ ] Codex as a worker: record the version and argv, start one from the persona, confirm its report reaches the persona, and confirm its `notify` payload carries `thread-id`.
- [ ] Stop and Start the app in Cube: the persona's full conversation is shown, the cut-off turn is recorded as interrupted, a Claude worker resumes with `--resume <id>`, a Codex worker resumes with `codex resume <id>`, and no duplicate workers appear.
- [ ] Dark and light themes both render correctly.
