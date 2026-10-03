// Adapted from cube-computer: src/main/cubed/attention/hooks.ts
//
// How a worker tells the app its turn ended. Both harnesses take
// per-invocation configuration, so nothing here edits a user's own settings
// file: claude takes `--settings <json>`, whose hooks run alongside the
// user's; codex takes `-c notify=[...]`, the one turn-completion program it
// has.
//
// Hooks run with no controlling terminal, so they cannot write into the
// worker's own stream. Each writes one file into the app's spool instead
// (spool.ts), named for the launch it belongs to. A hook must print NOTHING
// and always exit 0: a non-zero exit can block claude's turn.
import { join } from "node:path";

/** Bytes of one payload a hook keeps. */
export const MAX_REPORT_BYTES = 65_536;

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function template(spoolDir: string, launchId: string): string {
  return shellQuote(join(spoolDir, `${launchId}.XXXXXX`));
}

/**
 * Written under a temporary name and renamed, so the spool never reads a
 * half-written report. `mktemp` creates the file owner-only.
 */
export function stdinReportCommand(spoolDir: string, launchId: string): string {
  return `{ f=$(mktemp ${template(spoolDir, launchId)}) && head -c ${MAX_REPORT_BYTES} > "$f" && mv "$f" "$f.json"; } >/dev/null 2>&1; exit 0`;
}

/** The same, for a program handed its payload as its last argument (codex notify). */
export function argReportScript(spoolDir: string, launchId: string): string {
  return `{ f=$(mktemp ${template(spoolDir, launchId)}) && printf '%s' "$1" | head -c ${MAX_REPORT_BYTES} > "$f" && mv "$f" "$f.json"; } >/dev/null 2>&1; exit 0`;
}

/** claude's `--settings` value: only the `Stop` hook, which marks a turn's end. */
export function claudeSettings(spoolDir: string, launchId: string): string {
  const hooks = [{ type: "command", command: stdinReportCommand(spoolDir, launchId), timeout: 10 }];
  return JSON.stringify({ hooks: { Stop: [{ hooks }] } });
}

/** codex's `-c` value: a TOML array of basic strings (JSON string escapes are valid TOML ones). */
export function codexNotifyOverride(spoolDir: string, launchId: string): string {
  return `notify=${JSON.stringify(["sh", "-c", argReportScript(spoolDir, launchId), "cube-attention"])}`;
}
