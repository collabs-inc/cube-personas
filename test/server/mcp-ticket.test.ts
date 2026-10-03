// Adapted from cube-computer: src/main/cubed/mcp/ticket.test.ts
import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";
import { deriveTicket, verifyTicket } from "../../src/server/mcp/ticket";

const secret = Buffer.from("0123456789abcdef0123456789abcdef");
const other = Buffer.from("fedcba9876543210fedcba9876543210");

describe("mcp ticket", () => {
  test("is the hex HMAC-SHA256 of the labelled persona and launch under the secret", () => {
    const expected = createHmac("sha256", secret)
      .update(`cube-personas.mcp.v1\n${JSON.stringify(["p-1", "l-1"])}`).digest("hex");
    expect(deriveTicket(secret, "p-1", "l-1")).toBe(expected);
  });

  test("field concatenation cannot be made ambiguous", () => {
    expect(deriveTicket(secret, "a\nb", "c")).not.toBe(deriveTicket(secret, "a", "b\nc"));
  });

  test("verifies only the exact persona, launch and secret", () => {
    const t = deriveTicket(secret, "p-1", "l-1");
    expect(verifyTicket(secret, "p-1", "l-1", t)).toBe(true);
    expect(verifyTicket(secret, "p-2", "l-1", t)).toBe(false);
    expect(verifyTicket(secret, "p-1", "l-2", t)).toBe(false);
    expect(verifyTicket(other, "p-1", "l-1", t)).toBe(false);
  });

  test("is stable across processes, so a restarted server accepts a ticket for the same launch", () => {
    expect(deriveTicket(secret, "p-1", "l-1")).toBe(deriveTicket(Buffer.from(secret), "p-1", "l-1"));
  });

  test("a malformed ticket is refused rather than throwing", () => {
    expect(verifyTicket(secret, "p-1", "l-1", "")).toBe(false);
    expect(verifyTicket(secret, "p-1", "l-1", "!!not-hex!!")).toBe(false);
  });

  test("refuses malformed tickets without normalizing or truncating them", () => {
    const t = deriveTicket(secret, "p-1", "l-1");
    for (const ticket of ["!".repeat(64), "é".repeat(32), t.toUpperCase(), t.slice(0, -1), `${t}0`, `${t}!!`, `${t}\n`]) {
      expect(verifyTicket(secret, "p-1", "l-1", ticket)).toBe(false);
    }
  });
});
