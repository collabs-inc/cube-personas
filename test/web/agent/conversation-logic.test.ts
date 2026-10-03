// Adapted from cube-computer: src/windows/app/src/items/agent/conversation-logic.test.ts
import { expect, test } from "vitest";
import { nativePathFor, rendererPathFor, searchTurns, transcriptMarkdown } from "../../../src/web/agent/conversation-logic";
import type { Turn } from "../../../src/web/agent/transcript";

const context = { rendererCwd: "/@cloud/repo-1/src", nativeCwd: "/projects/app/src" };
test("file mentions and tool locations round-trip across cloud path spaces", () => {
  expect(nativePathFor("/@cloud/repo-1/src/a file.ts", context)).toBe("/projects/app/src/a file.ts");
  expect(rendererPathFor("/projects/app/src/a file.ts", context)).toBe("/@cloud/repo-1/src/a file.ts");
  expect(rendererPathFor("a.ts", context)).toBe("/@cloud/repo-1/src/a.ts");
  expect(nativePathFor("/@cloud/other/private.ts", context)).toBeNull();
  expect(rendererPathFor("/etc/passwd", context)).toBeNull();
  expect(nativePathFor("/@cloud/repo-1/a.ts", { ...context, nativeCwd: null })).toBeNull();
});
test("local file paths stay local and parent segments normalize safely", () => {
  const local = { rendererCwd: "/repo/src", nativeCwd: "/repo/src" };
  expect(rendererPathFor("../README.md", local)).toBe("/repo/README.md");
  expect(nativePathFor("/repo/src/file.ts", local)).toBe("/repo/src/file.ts");
});
test("Markdown file URLs decode safely at the file-navigation boundary", () => {
  expect(rendererPathFor("file:///projects/app/src/a%20file.ts", context)).toBe("/@cloud/repo-1/src/a file.ts");
  expect(rendererPathFor("file://foreign/projects/app/src/a.ts", context)).toBeNull();
  expect(rendererPathFor("file:///projects/app/src/%00secret", context)).toBeNull();
});
test("an encoded screenshot URI from a nested agent opens inside its original cloud checkout", () => {
  const nestedAgent = {
    rendererCwd: "/@cloud/repo-1/packages/browser/src",
    nativeCwd: "/projects/checkout with spaces/packages/browser/src",
  };
  const screenshotUri =
    "file:///projects/checkout%20with%20spaces/.cube/screenshots/conversation/capture.png";

  expect(rendererPathFor(screenshotUri, nestedAgent)).toBe(
    "/@cloud/repo-1/.cube/screenshots/conversation/capture.png",
  );
});
const turns: Turn[] = [{ id: "1", user: [{ type: "text", text: "Fix the loader" }], blocks: [
  { kind: "text", text: "Fixed **the loader**.\n\n```ts\nload();\n```" },
  { kind: "thought", text: "Look for the race." },
  { kind: "tool", call: { toolCallId: "t1", title: "Read bootstrap.ts", kind: "read", status: "completed", content: [], locations: [{ path: "/repo/bootstrap.ts" }] } },
], end: "end_turn" }];
test("search finds message and tool details, without interpreting regex syntax", () => {
  expect(searchTurns(turns, "BOOTSTRAP")).toEqual(["1"]);
  expect(searchTurns(turns, "loader")).toEqual(["1"]);
  expect(searchTurns(turns, "[.*]")).toEqual([]);
  expect(searchTurns(turns, " ")).toEqual([]);
});
test("export preserves readable roles, Markdown, and tool context", () => {
  const markdown = transcriptMarkdown(turns, "Loader fix");
  expect(markdown).toContain("# Loader fix");
  expect(markdown).toContain("## You");
  expect(markdown).toContain("**the loader**");
  expect(markdown).toContain("```ts\nload();\n```");
  expect(markdown).toContain("Read bootstrap.ts");
});
