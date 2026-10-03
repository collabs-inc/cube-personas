// Adapted from cube-computer: packages/shared/src/agent-protocol.test.ts
import { describe, expect, test } from "vitest";
import {
  isNotification, isRequest, isResponse, parseJsonRpc,
} from "../../src/shared/agent-protocol";

describe("agent-protocol", () => {
  test("classifies the three JSON-RPC shapes", () => {
    expect(isRequest({ jsonrpc: "2.0", id: 1, method: "x" })).toBe(true);
    expect(isNotification({ jsonrpc: "2.0", method: "x" })).toBe(true);
    expect(isResponse({ jsonrpc: "2.0", id: "d:1", result: {} })).toBe(true);
    expect(isResponse({ jsonrpc: "2.0", id: 2, error: { code: 1, message: "m" } })).toBe(true);
    expect(isRequest({ jsonrpc: "2.0", id: 1 })).toBe(false);
  });

  test("parseJsonRpc rejects non-objects and non-2.0", () => {
    expect(parseJsonRpc("[]")).toBeNull();
    expect(parseJsonRpc("not json")).toBeNull();
    expect(parseJsonRpc('{"jsonrpc":"1.0","method":"x"}')).toBeNull();
    expect(parseJsonRpc('{"jsonrpc":"2.0","method":"x"}')).toEqual({ jsonrpc: "2.0", method: "x" });
  });


});
