#!/usr/bin/env node
// Stands in for `codex` as a worker. Reads the argv the app composes, prints
// a banner, and for each turn (the launch prompt, then every line typed in)
// runs the `-c notify=[...]` program with
// { type: "agent-turn-complete", "thread-id", "last-assistant-message": "done: <prompt>" }
// as its last argument. `resume <id>` keeps that thread id. Typing `exit`
// ends it with code 0; typing `final: <prompt>` answers <prompt> and then
// exits at once; typing `slow: <prompt>` runs a turn that takes 800 ms.
// Turns run one at a time, in the order typed. FAKE_CODEX_SILENT=1 prints
// no banner.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
let notify = null;
let threadId = null;
let prompt = "";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "-c") {
    const value = args[++i] ?? "";
    if (value.startsWith("notify=")) notify = JSON.parse(value.slice("notify=".length));
    continue;
  }
  if (args[i] === "resume") { threadId = args[++i]; continue; }
  if (args[i].startsWith("-")) continue;
  prompt = args[i];
}
threadId ??= randomUUID();
// The app leads a launch prompt with its worker prefix and a blank line.
const cut = prompt.indexOf("\n\n");
if (cut >= 0) prompt = prompt.slice(cut + 2);

function answer(text) {
  if (!notify) return;
  const payload = JSON.stringify({
    type: "agent-turn-complete", "thread-id": threadId, "turn-id": randomUUID(), "last-assistant-message": "done: " + text,
  });
  execFileSync(notify[0], [...notify.slice(1), payload], { stdio: "ignore" });
}

if (process.env.FAKE_CODEX_SILENT !== "1") process.stdout.write(`fake-codex ${threadId} ready\r\n`);
if (prompt) answer(prompt);

let buffer = "";
let turns = Promise.resolve();
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.search(/[\r\n]/)) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === "exit") process.exit(0);
    if (line.startsWith("final: ")) {
      answer(line.slice("final: ".length));
      process.exit(0);
    }
    if (line.startsWith("slow: ")) {
      turns = turns.then(() => new Promise((r) => setTimeout(r, 800))).then(() => answer(line.slice("slow: ".length)));
    } else if (line) {
      turns = turns.then(() => answer(line));
    }
  }
});
setInterval(() => {}, 1000);
