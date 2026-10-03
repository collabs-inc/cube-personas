import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { capReportText, lastAssistantMessage, reportFromPayload } from "../../src/server/workers/report-text";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "personas-report-"));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const line = (v: unknown) => JSON.stringify(v) + "\n";

describe("claude Stop", () => {
  test("the last assistant text survives tool entries written after it", async () => {
    const path = join(tmp(), "t.jsonl");
    writeFileSync(path,
      line({ type: "user", message: { role: "user", content: "do it" } })
      + line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "first" }] } })
      + line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "All " }, { type: "text", text: "done." }] } })
      + line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } })
      + line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }));
    const report = await reportFromPayload("claude", { hook_event_name: "Stop", session_id: "sess-1", transcript_path: path });
    expect(report).toEqual({ kind: "turn-ended", text: "All done.", messageUnavailable: false, sessionId: "sess-1" });
  });

  test("a missing transcript marks the message unavailable", async () => {
    const report = await reportFromPayload("claude", { hook_event_name: "Stop", session_id: "s", transcript_path: join(tmp(), "nope.jsonl") });
    expect(report).toEqual({ kind: "turn-ended", text: "", messageUnavailable: true, sessionId: "s" });
  });

  test("a transcript path naming a FIFO is not opened: the message is unavailable", async () => {
    const fifo = join(tmp(), "fifo");
    execFileSync("mkfifo", [fifo]);
    const report = await reportFromPayload("claude", { hook_event_name: "Stop", session_id: "s", transcript_path: fifo });
    expect(report).toEqual({ kind: "turn-ended", text: "", messageUnavailable: true, sessionId: "s" });
  });

  test("a transcript path naming a directory marks the message unavailable", async () => {
    const report = await reportFromPayload("claude", { hook_event_name: "Stop", session_id: "s", transcript_path: tmp() });
    expect(report.messageUnavailable).toBe(true);
  });

  test("no transcript_path at all marks the message unavailable", async () => {
    const report = await reportFromPayload("claude", { hook_event_name: "Stop" });
    expect(report.messageUnavailable).toBe(true);
    expect(report.sessionId).toBeNull();
  });

  test("another hook event is not a turn end", async () => {
    expect((await reportFromPayload("claude", { hook_event_name: "UserPromptSubmit" })).kind).toBe("other");
  });

  test("a truncated payload still yields its transcript path", async () => {
    const path = join(tmp(), "t.jsonl");
    writeFileSync(path, line({ type: "assistant", message: { role: "assistant", content: "hi" } }));
    const raw = `{"session_id":"s2","transcript_path":${JSON.stringify(path)},"hook_event_name":"Stop","x":"aaaa`;
    expect(await reportFromPayload("claude", raw)).toEqual({ kind: "turn-ended", text: "hi", messageUnavailable: false, sessionId: "s2" });
  });
});

describe("codex agent-turn-complete", () => {
  test("text and thread id come from the payload", async () => {
    const report = await reportFromPayload("codex", { type: "agent-turn-complete", "thread-id": "th-1", "turn-id": "tu", "last-assistant-message": "Fixed." });
    expect(report).toEqual({ kind: "turn-ended", text: "Fixed.", messageUnavailable: false, sessionId: "th-1" });
  });

  test("no message marks it unavailable", async () => {
    const report = await reportFromPayload("codex", { type: "agent-turn-complete", "thread-id": "th-1" });
    expect(report.messageUnavailable).toBe(true);
  });

  test("a truncated payload is a turn end whose message is unavailable", async () => {
    const raw = `{"type":"agent-turn-complete","thread-id":"th-9","last-assistant-message":"cut sho`;
    expect(await reportFromPayload("codex", raw)).toEqual({ kind: "turn-ended", text: "", messageUnavailable: true, sessionId: "th-9" });
  });

  test("codex's private title-generation turn is not a turn end", async () => {
    const report = await reportFromPayload("codex", {
      type: "agent-turn-complete", "thread-id": "th-1",
      "input-messages": ["Generate a concise, single-line task title of at most 36 characters and under five words where possible. ..."],
      "last-assistant-message": "Fix bug",
    });
    expect(report.kind).toBe("other");
  });

  test("a claude payload handed to codex is not a turn end", async () => {
    expect((await reportFromPayload("codex", { hook_event_name: "Stop" })).kind).toBe("other");
  });
});

describe("capReportText", () => {
  test("10 KB of text is capped at 4096 bytes on a character boundary", async () => {
    const text = "é".repeat(5000); // 2 bytes each, 10 000 bytes
    const capped = capReportText(text);
    expect(Buffer.byteLength(capped)).toBe(4096);
    expect(capped).not.toContain("�");
    const odd = "a" + "€".repeat(4000); // 1 + 3n bytes
    const cappedOdd = capReportText(odd);
    expect(Buffer.byteLength(cappedOdd)).toBeLessThanOrEqual(4096);
    expect(Buffer.byteLength(cappedOdd)).toBeGreaterThan(4092);
    expect(cappedOdd).toBe("a" + "€".repeat(1365));
  });

  test("reportFromPayload applies the cap", async () => {
    const report = await reportFromPayload("codex", { type: "agent-turn-complete", "thread-id": "t", "last-assistant-message": "x".repeat(10_240) });
    expect(Buffer.byteLength(report.text)).toBe(4096);
  });

  test("lastAssistantMessage skips a cut first line", () => {
    expect(lastAssistantMessage('ssistant","message":{}}\n' + line({ message: { role: "assistant", content: "ok" } }))).toBe("ok");
  });
});
