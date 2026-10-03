// Adapted from cube-computer: src/windows/app/src/items/agent/session-controls.test.ts
import { describe, expect, test } from "vitest";
import {
  normalizeSessionConfigOptions,
  setConfigOptionRequest,
  setModelRequest,
} from "../../../src/web/agent/session-controls";

describe("session control request builders", () => {
  test("a select config request omits the boolean discriminator", () => {
    expect(setConfigOptionRequest("c:1", "s1", "model", "gpt-6-astra")).toEqual({
      jsonrpc: "2.0",
      id: "c:1",
      method: "session/set_config_option",
      params: { sessionId: "s1", configId: "model", value: "gpt-6-astra" },
    });
  });

  test("a boolean config request includes the required discriminator", () => {
    expect(setConfigOptionRequest("c:2", "s1", "telemetry", false)).toEqual({
      jsonrpc: "2.0",
      id: "c:2",
      method: "session/set_config_option",
      params: { sessionId: "s1", configId: "telemetry", type: "boolean", value: false },
    });
  });

  test("the isolated legacy model request uses modelId", () => {
    expect(setModelRequest("c:3", "s1", "legacy-model")).toEqual({
      jsonrpc: "2.0",
      id: "c:3",
      method: "session/set_model",
      params: { sessionId: "s1", modelId: "legacy-model" },
    });
  });
});

describe("normalizeSessionConfigOptions", () => {
  test("preserves valid flat selects, grouped selects, and booleans", () => {
    expect(
      normalizeSessionConfigOptions([
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "fast",
          options: [{ value: "fast", name: "Fast", description: "Quick replies" }],
        },
        {
          id: "region",
          name: "Region",
          type: "select",
          currentValue: "us",
          options: [{ group: "americas", name: "Americas", options: [{ value: "us", name: "US" }] }],
        },
        { id: "telemetry", name: "Telemetry", type: "boolean", currentValue: true },
      ]),
    ).toEqual([
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "fast",
        options: [{ value: "fast", name: "Fast", description: "Quick replies" }],
      },
      {
        id: "region",
        name: "Region",
        type: "select",
        currentValue: "us",
        options: [{ group: "americas", name: "Americas", options: [{ value: "us", name: "US" }] }],
      },
      { id: "telemetry", name: "Telemetry", type: "boolean", currentValue: true },
    ]);
  });

  test("drops malformed options and values instead of exposing unsafe UI data", () => {
    expect(
      normalizeSessionConfigOptions([
        null,
        { id: "missing-name", type: "boolean", currentValue: true },
        { id: "wrong-boolean", name: "Wrong", type: "boolean", currentValue: "yes" },
        {
          id: "mixed-select",
          name: "Mixed",
          type: "select",
          currentValue: "ok",
          options: [{ value: "ok", name: "Okay" }, { value: 1, name: "Bad" }, null],
        },
        { id: "future", name: "Future", type: "number", currentValue: 4 },
      ]),
    ).toEqual([
      {
        id: "mixed-select",
        name: "Mixed",
        type: "select",
        currentValue: "ok",
        options: [{ value: "ok", name: "Okay" }],
      },
    ]);
    expect(normalizeSessionConfigOptions("not-an-array")).toEqual([]);
  });
});
