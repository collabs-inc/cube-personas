// Adapted from cube-computer: src/main/cubed/agent-instructions.ts
//
// The `CODEX_CONFIG` a codex persona's adapter is spawned with. codex-acp
// forwards that JSON into codex as config overrides, and an override of
// `developer_instructions` REPLACES the user's own value rather than adding
// to it — so the persona's instructions are merged after whatever the user
// already told codex: an existing `CODEX_CONFIG.developer_instructions`
// first, else the top-level one in `$CODEX_HOME/config.toml` (default
// `~/.codex/config.toml`). An existing `CODEX_CONFIG` that is not a JSON
// object is left exactly as it is: refusing to inject is the only
// behaviour that cannot corrupt someone's configuration.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** A user's config value larger than this is not restated; ours ships alone. */
export const MAX_USER_INSTRUCTIONS_BYTES = 64 * 1024;

export interface CodexConfigDeps {
  readFile(path: string): Promise<string>;
  warn(line: string): void;
}

const defaultDeps: CodexConfigDeps = {
  readFile: (path) => readFile(path, "utf8"),
  warn: (line) => console.warn(line),
};

/**
 * The environment variables the adapter gains: `{ CODEX_CONFIG }`, or `{}`
 * when there is nothing to add or the existing value cannot be merged.
 */
export async function codexConfigEnv(
  env: NodeJS.ProcessEnv,
  instructions: string,
  deps: CodexConfigDeps = defaultDeps,
): Promise<Record<string, string>> {
  if (instructions === "") return {};
  const existing = jsonObject(env.CODEX_CONFIG, deps);
  if (existing === null) return {};
  const merged = typeof existing.developer_instructions === "string"
    ? `${existing.developer_instructions}\n\n${instructions}`
    : await withConfigFileInstructions(env, instructions, deps, "persona");
  return { CODEX_CONFIG: JSON.stringify({ ...existing, developer_instructions: merged }) };
}

function jsonObject(raw: string | undefined, deps: CodexConfigDeps): Record<string, unknown> | null {
  if (raw === undefined || raw.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    deps.warn("persona instructions: CODEX_CONFIG is not valid JSON, left unchanged");
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    deps.warn("persona instructions: CODEX_CONFIG is not a JSON object, left unchanged");
    return null;
  }
  return parsed as Record<string, unknown>;
}

function configPath(env: NodeJS.ProcessEnv): string {
  const codexHome = env.CODEX_HOME;
  if (codexHome !== undefined && codexHome.length > 0) return join(codexHome, "config.toml");
  const home = env.HOME !== undefined && env.HOME.length > 0 ? env.HOME : homedir();
  return join(home, ".codex", "config.toml");
}

/**
 * The user's own `developer_instructions` from codex's config.toml first,
 * then ours; a file that cannot be read or understood is reported and ours
 * ships alone. A codex worker's `-c developer_instructions=` uses it too,
 * since that override replaces the user's value just as CODEX_CONFIG does.
 */
export async function withConfigFileInstructions(
  env: NodeJS.ProcessEnv, instructions: string, deps: CodexConfigDeps = defaultDeps, who: "persona" | "worker" = "worker",
): Promise<string> {
  const path = configPath(env);
  let contents: string;
  try {
    contents = await deps.readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      deps.warn(`${who} instructions: could not read ${path}: ${String(err)}`);
    }
    return instructions;
  }
  const read = readDeveloperInstructions(contents);
  if (read.kind === "unrecognised") {
    deps.warn(`${who} instructions: developer_instructions in ${path} is in a form this app cannot read; sending ours alone`);
    return instructions;
  }
  if (read.kind === "absent") return instructions;
  if (Buffer.byteLength(read.text) > MAX_USER_INSTRUCTIONS_BYTES) {
    deps.warn(`${who} instructions: developer_instructions in ${path} exceeds ${MAX_USER_INSTRUCTIONS_BYTES} bytes; sending ours alone`);
    return instructions;
  }
  return `${read.text}\n\n${instructions}`;
}

export type DeveloperInstructionsRead =
  | { kind: "absent" }
  | { kind: "value"; text: string }
  | { kind: "unrecognised" };

/**
 * A deliberately small reader for ONE top-level key of a TOML file, in the
 * four string forms TOML has. Anything it does not fully recognise answers
 * `unrecognised`, because a wrong read would silently rewrite what the user
 * told codex to do. Top-level only: scanning stops at the first table header.
 */
export function readDeveloperInstructions(toml: string): DeveloperInstructionsRead {
  const lines = toml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) return { kind: "absent" };
    const match = /^developer_instructions\s*=\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    return readValue(match[1]!, lines.slice(i + 1));
  }
  return { kind: "absent" };
}

function readValue(rest: string, following: string[]): DeveloperInstructionsRead {
  for (const [open, raw] of [['"""', false], ["'''", true]] as const) {
    if (!rest.startsWith(open)) continue;
    const body = [rest.slice(open.length), ...following].join("\n");
    const end = body.indexOf(open);
    if (end === -1) return { kind: "unrecognised" };
    // TOML trims a newline immediately after the opening delimiter.
    const text = body.slice(0, end).replace(/^\r?\n/, "");
    return raw ? { kind: "value", text } : unescapeBasic(text);
  }
  if (rest.startsWith('"')) {
    const match = /^"((?:[^"\\]|\\.)*)"/.exec(rest);
    return match ? unescapeBasic(match[1]!) : { kind: "unrecognised" };
  }
  if (rest.startsWith("'")) {
    const match = /^'([^']*)'/.exec(rest);
    return match ? { kind: "value", text: match[1]! } : { kind: "unrecognised" };
  }
  return { kind: "unrecognised" };
}

const BASIC_ESCAPES: Record<string, string> = {
  b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\",
};

function unescapeBasic(text: string): DeveloperInstructionsRead {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char !== "\\") { out += char; continue; }
    const next = text[i + 1];
    if (next === undefined) return { kind: "unrecognised" };
    const simple = BASIC_ESCAPES[next];
    if (simple !== undefined) { out += simple; i += 1; continue; }
    if (next === "u" || next === "U") {
      const width = next === "u" ? 4 : 8;
      const digits = text.slice(i + 2, i + 2 + width);
      if (!new RegExp(`^[0-9a-fA-F]{${width}}$`).test(digits)) return { kind: "unrecognised" };
      out += String.fromCodePoint(Number.parseInt(digits, 16));
      i += 1 + width;
      continue;
    }
    // A backslash ending a line continues it, trimming the whitespace up to the next non-whitespace character.
    const continuation = /^[ \t]*\r?\n\s*/.exec(text.slice(i + 1));
    if (continuation) { i += continuation[0].length; continue; }
    return { kind: "unrecognised" };
  }
  return { kind: "value", text: out };
}
