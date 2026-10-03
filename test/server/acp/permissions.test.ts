// Adapted from cube-computer: src/main/cubed/acp/permissions.test.ts
import { describe, expect, test } from "vitest";
import { claimPermission } from "../../../src/server/acp/permissions";

const view = (pending: Array<string | number>, answered: Array<string | number> = []) =>
  ({ pending: new Set(pending), answered: new Set(answered) });

describe("claimPermission", () => {
  test("claims a pending request exactly once", () => {
    const v = view(["a:1"]);
    expect(claimPermission(v, "a:1")).toBe("answered");
    expect(v.answered.has("a:1")).toBe(true);
    // Second claim loses, and does not re-write.
    expect(claimPermission(v, "a:1")).toBe("lost-race");
  });

  test("a request nobody is waiting on is stale, not answered", () => {
    // A turn that already ended clears its pending permissions; answering one afterwards must not reach the adapter.
    expect(claimPermission(view([]), "a:9")).toBe("stale");
  });

  test("an already-answered id is a lost race even if still pending", () => {
    expect(claimPermission(view(["a:1"], ["a:1"]), "a:1")).toBe("lost-race");
  });

  test("preserves pending and answered sets on refusal and distinguishes id types", () => {
    const v = view([0], ["done"]);
    expect(claimPermission(v, "0")).toBe("stale");
    expect(claimPermission(v, "done")).toBe("lost-race");
    expect([...v.answered]).toEqual(["done"]);
    expect([...v.pending]).toEqual([0]);
    expect(claimPermission(v, 0)).toBe("answered");
    expect([...v.pending]).toEqual([0]);
  });
});
