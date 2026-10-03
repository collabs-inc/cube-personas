// Adapted from cube-computer: src/main/cubed/agent-instructions.ts (composeLaunchArgs, placeInstructionArgs, tomlBasicString)
//
// A worker's whole argv: the attention hook, the permission-skip flag, the
// artifact instruction, the session flags and, last, the prompt led by
// WORKER_PROMPT_PREFIX. As in Cube, codex's instruction goes before its
// `resume` subcommand and the prompt after everything.
import type { Harness } from "../../shared/types";
import { ARTIFACT_INSTRUCTION, WORKER_PROMPT_PREFIX } from "../instructions";
import { claudeSettings, codexNotifyOverride } from "./hooks";

export interface WorkerArgvOptions {
  harness: Harness;
  spoolDir: string;
  launchId: string;
  prompt: string | null;
  /** Required for claude (minted by the app); codex's thread id, or null before its first turn. */
  sessionId: string | null;
  resume: boolean;
  /** Codex's `developer_instructions`: the user's own merged ahead of the artifact instruction. Defaults to the instruction alone. */
  codexInstructions?: string;
}

/**
 * A TOML basic string. JSON's escapes and TOML's differ at the edges, so
 * only the escapes both grammars share are used, keeping it exactly
 * reversible.
 */
export function tomlBasicString(text: string): string {
  let out = '"';
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (char === '"' || char === "\\") out += `\\${char}`;
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char === "\t") out += "\\t";
    else if (char === "\b") out += "\\b";
    else if (char === "\f") out += "\\f";
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += char;
  }
  return `${out}"`;
}

export function workerArgv(opts: WorkerArgvOptions): { command: string; args: string[] } {
  const prompt = opts.prompt ? [`${WORKER_PROMPT_PREFIX}\n\n${opts.prompt}`] : [];
  if (opts.harness === "claude") {
    if (!opts.sessionId) throw new Error("A claude worker needs a session id.");
    return {
      command: "claude",
      args: [
        "--settings", claudeSettings(opts.spoolDir, opts.launchId),
        "--dangerously-skip-permissions",
        "--append-system-prompt", ARTIFACT_INSTRUCTION,
        ...(opts.resume ? ["--resume", opts.sessionId] : ["--session-id", opts.sessionId]),
        ...prompt,
      ],
    };
  }
  return {
    command: "codex",
    args: [
      "-c", codexNotifyOverride(opts.spoolDir, opts.launchId),
      "--dangerously-bypass-approvals-and-sandbox",
      "-c", `developer_instructions=${tomlBasicString(opts.codexInstructions ?? ARTIFACT_INSTRUCTION)}`,
      ...(opts.resume && opts.sessionId ? ["resume", opts.sessionId] : []),
      ...prompt,
    ],
  };
}
