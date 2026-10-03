import { describe, expect, test } from "vitest";
import { tomlBasicString, workerArgv } from "../../src/server/workers/argv";
import { argReportScript, claudeSettings, stdinReportCommand } from "../../src/server/workers/hooks";
import { ARTIFACT_INSTRUCTION, WORKER_PROMPT_PREFIX } from "../../src/server/instructions";

const SPOOL = "/state/attention";
const LAUNCH = "0f2c9a52-7d0e-4d2f-9a51-3c1f0e8b6a11";
const SESSION = "6b1d3c0e-1f6a-4a8e-b2c4-5d9e7f0a1b2c";

const claudeHook = JSON.stringify({
  hooks: { Stop: [{ hooks: [{ type: "command", command: stdinReportCommand(SPOOL, LAUNCH), timeout: 10 }] }] },
});
const codexNotify = `notify=${JSON.stringify(["sh", "-c", argReportScript(SPOOL, LAUNCH), "cube-attention"])}`;
const codexInstruction = `developer_instructions=${tomlBasicString(ARTIFACT_INSTRUCTION)}`;
const prefixed = (prompt: string) => `${WORKER_PROMPT_PREFIX}\n\n${prompt}`;

describe("hook one-liners", () => {
  test("are Cube's: write <spool>/<launch>.XXXXXX, rename to .json, print nothing, exit 0", () => {
    expect(stdinReportCommand(SPOOL, LAUNCH)).toBe(
      `{ f=$(mktemp '/state/attention/${LAUNCH}.XXXXXX') && head -c 65536 > "$f" && mv "$f" "$f.json"; } >/dev/null 2>&1; exit 0`,
    );
    expect(argReportScript(SPOOL, LAUNCH)).toBe(
      `{ f=$(mktemp '/state/attention/${LAUNCH}.XXXXXX') && printf '%s' "$1" | head -c 65536 > "$f" && mv "$f" "$f.json"; } >/dev/null 2>&1; exit 0`,
    );
  });

  test("claude's settings carry only a Stop hook", () => {
    expect(Object.keys(JSON.parse(claudeSettings(SPOOL, LAUNCH)).hooks)).toEqual(["Stop"]);
  });

  test("a spool path with a quote stays one shell word", () => {
    expect(stdinReportCommand("/it's", LAUNCH)).toContain(`mktemp '/it'\\''s/${LAUNCH}.XXXXXX'`);
  });
});

describe("workerArgv", () => {
  test("claude, fresh, with a prompt", () => {
    expect(workerArgv({ harness: "claude", spoolDir: SPOOL, launchId: LAUNCH, prompt: "fix the bug", sessionId: SESSION, resume: false })).toEqual({
      command: "claude",
      args: [
        "--settings", claudeHook, "--dangerously-skip-permissions", "--append-system-prompt", ARTIFACT_INSTRUCTION,
        "--session-id", SESSION, prefixed("fix the bug"),
      ],
    });
  });

  test("claude, fresh, without a prompt", () => {
    expect(workerArgv({ harness: "claude", spoolDir: SPOOL, launchId: LAUNCH, prompt: null, sessionId: SESSION, resume: false }).args).toEqual([
      "--settings", claudeHook, "--dangerously-skip-permissions", "--append-system-prompt", ARTIFACT_INSTRUCTION,
      "--session-id", SESSION,
    ]);
  });

  test("claude, resumed, with and without a prompt", () => {
    const base = ["--settings", claudeHook, "--dangerously-skip-permissions", "--append-system-prompt", ARTIFACT_INSTRUCTION, "--resume", SESSION];
    expect(workerArgv({ harness: "claude", spoolDir: SPOOL, launchId: LAUNCH, prompt: null, sessionId: SESSION, resume: true }).args).toEqual(base);
    const withPrompt = workerArgv({ harness: "claude", spoolDir: SPOOL, launchId: LAUNCH, prompt: "go on", sessionId: SESSION, resume: true }).args;
    expect(withPrompt).toEqual([...base, prefixed("go on")]);
    expect(withPrompt.at(-1)).toBe(prefixed("go on"));
  });

  test("claude without a session id is refused", () => {
    expect(() => workerArgv({ harness: "claude", spoolDir: SPOOL, launchId: LAUNCH, prompt: null, sessionId: null, resume: false })).toThrow();
  });

  test("codex, fresh, with and without a prompt", () => {
    const base = ["-c", codexNotify, "--dangerously-bypass-approvals-and-sandbox", "-c", codexInstruction];
    expect(workerArgv({ harness: "codex", spoolDir: SPOOL, launchId: LAUNCH, prompt: null, sessionId: null, resume: false })).toEqual({ command: "codex", args: base });
    const withPrompt = workerArgv({ harness: "codex", spoolDir: SPOOL, launchId: LAUNCH, prompt: "fix it", sessionId: null, resume: false }).args;
    expect(withPrompt).toEqual([...base, prefixed("fix it")]);
  });

  test("codex, resumed: the instruction precedes `resume <id>` and the prompt is last", () => {
    const base = ["-c", codexNotify, "--dangerously-bypass-approvals-and-sandbox", "-c", codexInstruction, "resume", SESSION];
    expect(workerArgv({ harness: "codex", spoolDir: SPOOL, launchId: LAUNCH, prompt: null, sessionId: SESSION, resume: true }).args).toEqual(base);
    const withPrompt = workerArgv({ harness: "codex", spoolDir: SPOOL, launchId: LAUNCH, prompt: "more", sessionId: SESSION, resume: true }).args;
    expect(withPrompt).toEqual([...base, prefixed("more")]);
    expect(withPrompt.at(-1)).toBe(prefixed("more"));
  });

  test("codex carries the merged developer instructions it is given in place of the instruction alone", () => {
    const args = workerArgv({ harness: "codex", spoolDir: SPOOL, launchId: LAUNCH, prompt: null, sessionId: null, resume: false, codexInstructions: "mine\n\nours" }).args;
    expect(args).toContain(`developer_instructions=${tomlBasicString("mine\n\nours")}`);
  });

  test("the codex notify value is the exact TOML array Cube writes", () => {
    expect(codexNotify.startsWith('notify=["sh","-c","{ f=$(mktemp')).toBe(true);
    expect(codexNotify.endsWith('"cube-attention"]')).toBe(true);
  });
});

describe("tomlBasicString", () => {
  test("escapes quotes, backslashes, newlines and control characters", () => {
    expect(tomlBasicString('a "b" \\ c\nd\te\u0001')).toBe('"a \\"b\\" \\\\ c\\nd\\te\\u0001"');
  });

  test("round-trips the artifact instruction through JSON (whose escapes these are a subset of)", () => {
    expect(JSON.parse(tomlBasicString(ARTIFACT_INSTRUCTION))).toBe(ARTIFACT_INSTRUCTION);
  });
});
