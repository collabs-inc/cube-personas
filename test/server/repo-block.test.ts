// Adapted from cube-computer: src/main/cubed/personas/repo-block.test.ts
import { describe, expect, test } from "vitest";
import {
  assertAbsolutePaths, parseRepoBlock, REPO_BLOCK_MARKER, writeRepoBlock,
} from "../../src/server/repo-block";

const doc = (entries: string, after = "") =>
  `# Ada\n\nPreamble.\n\n## Repositories\n${REPO_BLOCK_MARKER}\n${entries}${after}`;

describe("parseRepoBlock", () => {
  test("reads entries up to the next heading", () => {
    const text = doc("- /r/a\n- /r/b\n", "\n## Notes\n- /not/a/repo\n");
    expect(parseRepoBlock(text)).toEqual(["/r/a", "/r/b"]);
  });
  test("no marker means an empty set", () => {
    expect(parseRepoBlock("# Ada\n- /r/a\n")).toEqual([]);
  });
  test("ignores prose, relative paths and duplicates", () => {
    expect(parseRepoBlock(doc("- /r/a\nwe use a for x\n- rel/b\n- /r/a\n"))).toEqual(["/r/a"]);
  });
  test("handles CRLF", () => {
    expect(parseRepoBlock(doc("- /r/a\n").replace(/\n/g, "\r\n"))).toEqual(["/r/a"]);
  });
});

describe("writeRepoBlock", () => {
  test("replaces only entry lines and keeps prose inside the block", () => {
    const before = doc("- /r/a\nnote line\n", "\n## Notes\nkeep\n");
    const after = writeRepoBlock(before, ["/r/b"]);
    expect(parseRepoBlock(after)).toEqual(["/r/b"]);
    expect(after).toContain("note line\n");
    expect(after.endsWith("\n## Notes\nkeep\n")).toBe(true);
  });
  test("appends a block when the marker is missing", () => {
    const after = writeRepoBlock("# Ada\n", ["/r/a"]);
    expect(after).toBe(`# Ada\n\n## Repositories\n${REPO_BLOCK_MARKER}\n- /r/a\n`);
  });
  test("preserves CRLF line endings", () => {
    const before = doc("- /r/a\n").replace(/\n/g, "\r\n");
    expect(writeRepoBlock(before, ["/r/b"])).toBe(doc("- /r/b\n").replace(/\n/g, "\r\n"));
  });
  test("every byte outside the entry lines survives (generated inputs)", () => {
    for (let seed = 0; seed < 200; seed++) {
      const lines = Array.from({ length: seed % 7 }, (_, i) =>
        (i + seed) % 3 === 0 ? `- /r/${i}` : `text ${i}`
      );
      const head = `# P${seed}\n\nfree ${seed}\n`;
      const tail = seed % 2 ? `\n## Tail\nx${seed}\n` : "";
      const before =
        `${head}\n## Repositories\n${REPO_BLOCK_MARKER}\n${lines.join("\n")}\n${tail}`;
      const after = writeRepoBlock(before, ["/z"]);
      const strip = (s: string) => s.split("\n").filter(l => !l.startsWith("- /")).join("\n");
      expect(strip(after)).toBe(strip(before));
      expect(parseRepoBlock(after)).toEqual(["/z"]);
    }
  });
});

test("assertAbsolutePaths names the first relative path", () => {
  expect(() => assertAbsolutePaths(["/ok", "rel"])).toThrow('"rel" is not an absolute path');
});

test.each(["/r/app\n## Injected", "/r/app\r- /injected", "/r/app\r\n- /injected"])(
  "assertAbsolutePaths refuses line breaks and names the entry: %j", entry => {
    expect(() => assertAbsolutePaths(["/ok", entry]))
      .toThrow(`${JSON.stringify(entry)} contains a line break`);
  },
);
