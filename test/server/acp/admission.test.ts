// Adapted from cube-computer: src/main/cubed/acp/prompt-admission.test.ts
import { describe, expect, test } from "vitest";
import { admitPrompt } from "../../../src/server/acp/admission";

describe("admitPrompt", () => {
  test("admits only a ready session", () => {
    expect(admitPrompt({ state: "ready" })).toEqual({ ok: true });
  });

  test("refuses a session that is already running a turn", () => {
    expect(admitPrompt({ state: "busy" })).toEqual({ ok: false, reason: "busy" });
  });

  test("refuses a session still handshaking, which merely LOOKS idle", () => {
    expect(admitPrompt({ state: "handshaking" })).toEqual({ ok: false, reason: "handshaking" });
  });

  test("refuses a dead session", () => {
    expect(admitPrompt({ state: "dead" })).toEqual({ ok: false, reason: "dead" });
  });
});
