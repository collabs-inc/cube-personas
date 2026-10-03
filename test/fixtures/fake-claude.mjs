#!/usr/bin/env node
// Adapted from cube-computer: src/main/cubed/personas/e2e.test.ts (FAKE_CLAUDE_WORKER)
//
// Stands in for `claude` as a worker. Reads the argv the app composes, prints
// a banner, and for each turn (the launch prompt, then every line typed in)
// appends one assistant entry "done: <prompt>" to a transcript under
// $HOME/.fake-claude/ and runs the Stop hook from --settings with
// { session_id, transcript_path, hook_event_name: "Stop" } on stdin.
// Typing `exit` ends it with code 0. FAKE_CLAUDE_IGNORE_HUP=1 makes it
// survive its terminal's hangup, as a process that outlives a killed server.
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const valueOf = (flag) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};
const settings = valueOf("--settings");
const hooks = settings ? JSON.parse(settings).hooks ?? {} : {};
const sessionId = valueOf("--resume") ?? valueOf("--session-id") ?? randomUUID();
const dir = join(homedir(), ".fake-claude");
mkdirSync(dir, { recursive: true });
const transcript = join(dir, `${sessionId}.jsonl`);

const PAIRS = ["--settings", "--append-system-prompt", "--session-id", "--resume"];
function promptOf(argv) {
  let prompt = "";
  for (let i = 0; i < argv.length; i++) {
    if (PAIRS.includes(argv[i])) { i++; continue; }
    if (argv[i].startsWith("--")) continue;
    prompt = argv[i];
  }
  // The app leads a launch prompt with its worker prefix and a blank line.
  const at = prompt.indexOf("\n\n");
  return at >= 0 ? prompt.slice(at + 2) : prompt;
}

function answer(text) {
  appendFileSync(transcript, JSON.stringify({
    type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done: " + text }] },
  }) + "\n");
  const hook = hooks.Stop && hooks.Stop[0].hooks[0].command;
  if (hook) execSync(hook, { input: JSON.stringify({ session_id: sessionId, transcript_path: transcript, hook_event_name: "Stop" }) });
}

if (process.env.FAKE_CLAUDE_IGNORE_HUP === "1") {
  process.on("SIGHUP", () => {});
  process.stdin.on("error", () => {});
  process.stdout.on("error", () => {});
}

process.stdout.write(`fake-claude ${sessionId} ready\r\n`);
const initial = promptOf(args);
if (initial) answer(initial);

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.search(/[\r\n]/)) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === "exit") process.exit(0);
    if (line) answer(line);
  }
});
setInterval(() => {}, 1000);
