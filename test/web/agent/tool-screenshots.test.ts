// Adapted from cube-computer: src/windows/app/src/items/agent/tool-screenshots.test.ts
import { describe, expect, test } from "vitest";
import type { ToolCallState } from "../../../src/web/agent/transcript";
import { createScreenshotResolver, screenshotReferences } from "../../../src/web/agent/tool-screenshots";

const first = "/projects/repo/.cube/screenshots/conversation-1/first shot.png";
const second = "/projects/repo/.cube/screenshots/conversation-1/second.png";
const resolve = (path: string) => {
  const nativePath = decodeURIComponent(path.replace(/^file:\/\//, ""));
  return nativePath.startsWith("/projects/repo/.cube/screenshots/conversation-1/")
    ? { nativePath, rendererPath: `/renderer${nativePath}` }
    : null;
};
const call = (overrides: Partial<ToolCallState>): ToolCallState => ({
  toolCallId: "tool-1", title: "Capture", kind: "other", status: "completed",
  content: [], locations: [], ...overrides,
});

describe("screenshotReferences", () => {
  test("extracts generated Markdown links from result text and nested raw output", () => {
    const result = screenshotReferences(call({
      content: [{ type: "content", content: { type: "text", text: `Saved [Screenshot](file://${first.replace(" ", "%20")})` } }],
      rawOutput: { nested: [{ capture: `[Screenshot](file://${second})` }] },
    }), resolve);
    expect(result).toEqual([
      { nativePath: first, rendererPath: `/renderer${first}` },
      { nativePath: second, rendererPath: `/renderer${second}` },
    ]);
  });

  test("recognizes image resource links and deduplicates normalized paths", () => {
    const result = screenshotReferences(call({ content: [
      { type: "content", content: { type: "resource_link", name: "shot", uri: `file://${first}`, mimeType: "image/png" } },
      { type: "content", content: { type: "text", text: `[Screenshot](file://${first.replace("first shot", "folder/../first%20shot")})` } },
    ] }), resolve);
    expect(result).toEqual([{ nativePath: first, rendererPath: `/renderer${first}` }]);
  });

  test("does not inspect raw input, ordinary paths, external URLs, or embedded image resources already rendered", () => {
    const result = screenshotReferences(call({
      rawInput: { future: `[Screenshot](file://${first})` },
      rawOutput: { source: "/projects/repo/src/image.png", url: "https://example.test/image.png" },
      content: [{ type: "content", content: { type: "resource", resource: { uri: `file://${second}`, mimeType: "image/png", blob: "AAAA" } } }],
    }), resolve);
    expect(result).toEqual([]);
  });

  test("bounds traversal and safely ignores cycles", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const buried: Record<string, unknown> = { capture: `[Screenshot](file://${first})`, cycle: cyclic };
    let deep: Record<string, unknown> = buried;
    for (let index = 0; index < 33; index += 1) deep = { child: deep };
    expect(screenshotReferences(call({ rawOutput: deep }), resolve)).toEqual([]);

    const nodes = Array.from({ length: 10_001 }, (_, index) => index === 10_000 ? `[Screenshot](file://${first})` : index);
    expect(screenshotReferences(call({ rawOutput: nodes }), resolve)).toEqual([]);
  });
});

describe("createScreenshotResolver", () => {
  test("maps only files in this conversation screenshot directory", () => {
    const resolver = createScreenshotResolver({ rendererCwd: "/@cloud/repo-1", nativeCwd: "/projects/repo" }, "conversation-1");
    expect(resolver(`file://${first.replace(" ", "%20")}`)).toEqual({
      nativePath: first,
      rendererPath: "/@cloud/repo-1/.cube/screenshots/conversation-1/first shot.png",
    });
    expect(resolver("file:///projects/repo/.cube/screenshots/other/first.png")).toBeNull();
    expect(resolver("file:///projects/repo/.cube/screenshots/conversation-1/../other/first.png")).toBeNull();
    expect(resolver("file:///projects/repo/nested/.cube/screenshots/conversation-1/first.png")).toBeNull();
    expect(resolver("file:///projects/repo/.cube/screenshots/conversation-1/file.txt")).toBeNull();
  });
});
