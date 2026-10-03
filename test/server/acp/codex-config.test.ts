// Adapted from cube-computer: src/main/cubed/agent-instructions.test.ts
import { describe, expect, test } from "vitest";
import {
  codexConfigEnv, MAX_USER_INSTRUCTIONS_BYTES, readDeveloperInstructions, type CodexConfigDeps,
} from "../../../src/server/acp/codex-config";

const OURS = "You are a persona.";
const CONFIG = "/home/u/.codex/config.toml";

function world(files: Record<string, string> = {}) {
  const warnings: string[] = [];
  const deps: CodexConfigDeps = {
    readFile: async (path) => {
      const content = files[path];
      if (content === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return content;
    },
    warn: (line) => warnings.push(line),
  };
  return { deps, warnings };
}

const instructionsOf = (env: Record<string, string>) => JSON.parse(env.CODEX_CONFIG!).developer_instructions;

describe("codexConfigEnv", () => {
  test("with no config anywhere, ships ours alone", async () => {
    const { deps, warnings } = world();
    expect(JSON.parse((await codexConfigEnv({ HOME: "/home/u" }, OURS, deps)).CODEX_CONFIG!))
      .toEqual({ developer_instructions: OURS });
    expect(warnings).toEqual([]);
  });

  test("the user's config.toml value comes first, then ours", async () => {
    const { deps } = world({ [CONFIG]: 'developer_instructions = "mine"\n' });
    expect(instructionsOf(await codexConfigEnv({ HOME: "/home/u" }, OURS, deps))).toBe(`mine\n\n${OURS}`);
  });

  test("CODEX_HOME relocates the config file", async () => {
    const { deps } = world({ "/elsewhere/config.toml": "developer_instructions = 'from CODEX_HOME'\n" });
    expect(instructionsOf(await codexConfigEnv({ HOME: "/home/u", CODEX_HOME: "/elsewhere" }, OURS, deps)))
      .toBe(`from CODEX_HOME\n\n${OURS}`);
  });

  test("an existing CODEX_CONFIG keeps its other keys", async () => {
    const { deps } = world();
    const env = await codexConfigEnv({ HOME: "/home/u", CODEX_CONFIG: '{"model":"gpt-5"}' }, OURS, deps);
    expect(JSON.parse(env.CODEX_CONFIG!)).toEqual({ model: "gpt-5", developer_instructions: OURS });
  });

  test("an existing CODEX_CONFIG developer_instructions wins over the file's, and ours follows it", async () => {
    const { deps } = world({ [CONFIG]: 'developer_instructions = "File instructions"\n' });
    const env = await codexConfigEnv({
      HOME: "/home/u", CODEX_CONFIG: JSON.stringify({ developer_instructions: "Environment instructions" }),
    }, OURS, deps);
    expect(instructionsOf(env)).toBe(`Environment instructions\n\n${OURS}`);
  });

  test("an unparseable CODEX_CONFIG is left exactly as the caller set it", async () => {
    const { deps, warnings } = world();
    expect(await codexConfigEnv({ CODEX_CONFIG: "not json" }, OURS, deps)).toEqual({});
    expect(await codexConfigEnv({ CODEX_CONFIG: "[1]" }, OURS, deps)).toEqual({});
    expect(warnings.length).toBe(2);
    expect(warnings[0]).toContain("CODEX_CONFIG");
  });

  test("an unreadable config file warns once and ships ours alone", async () => {
    const { deps, warnings } = world();
    deps.readFile = async () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); };
    expect(instructionsOf(await codexConfigEnv({ HOME: "/home/u" }, OURS, deps))).toBe(OURS);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain(CONFIG);
  });

  test("a value form the reader does not recognise, or one too large, is not restated", async () => {
    const odd = world({ [CONFIG]: "developer_instructions = 42\n" });
    expect(instructionsOf(await codexConfigEnv({ HOME: "/home/u" }, OURS, odd.deps))).toBe(OURS);
    expect(odd.warnings.length).toBe(1);
    const big = world({ [CONFIG]: `developer_instructions = "${"x".repeat(MAX_USER_INSTRUCTIONS_BYTES + 1)}"\n` });
    expect(instructionsOf(await codexConfigEnv({ HOME: "/home/u" }, OURS, big.deps))).toBe(OURS);
    expect(big.warnings.length).toBe(1);
  });

  test("empty instructions add nothing", async () => {
    expect(await codexConfigEnv({ CODEX_CONFIG: '{"model":"m"}' }, "", world().deps)).toEqual({});
  });
});

describe("the tolerant extractor", () => {
  test("reads every string form TOML has", () => {
    expect(readDeveloperInstructions('developer_instructions = "a\\nb"')).toEqual({ kind: "value", text: "a\nb" });
    expect(readDeveloperInstructions("developer_instructions = 'a\\nb'")).toEqual({ kind: "value", text: "a\\nb" });
    expect(readDeveloperInstructions('developer_instructions = """\nline one\nline two"""'))
      .toEqual({ kind: "value", text: "line one\nline two" });
    expect(readDeveloperInstructions("developer_instructions = '''\nraw \\n text'''"))
      .toEqual({ kind: "value", text: "raw \\n text" });
    expect(readDeveloperInstructions("developer_instructions=\"tight\"")).toEqual({ kind: "value", text: "tight" });
    // A line-ending backslash joins the lines and keeps escaping after it.
    expect(readDeveloperInstructions('developer_instructions = """\\\n  one \\t two \\\n  three"""'))
      .toEqual({ kind: "value", text: "one \t two three" });
  });

  test("absent, commented out, or nested in a table means the user has none", () => {
    expect(readDeveloperInstructions("model = \"gpt-5\"\n")).toEqual({ kind: "absent" });
    expect(readDeveloperInstructions('# developer_instructions = "off"\n')).toEqual({ kind: "absent" });
    expect(readDeveloperInstructions('[profiles.work]\ndeveloper_instructions = "work only"\n')).toEqual({ kind: "absent" });
    expect(readDeveloperInstructions("developer_instructions_extra = \"other key\"\n")).toEqual({ kind: "absent" });
  });

  test("an unterminated or non-string value is unrecognised, never a guess", () => {
    expect(readDeveloperInstructions('developer_instructions = "unterminated\n')).toEqual({ kind: "unrecognised" });
    expect(readDeveloperInstructions('developer_instructions = """never closed\n')).toEqual({ kind: "unrecognised" });
    expect(readDeveloperInstructions("developer_instructions = 42\n")).toEqual({ kind: "unrecognised" });
    expect(readDeveloperInstructions('developer_instructions = ["a"]\n')).toEqual({ kind: "unrecognised" });
  });
});
