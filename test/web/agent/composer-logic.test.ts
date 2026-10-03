// Adapted from cube-computer: src/windows/app/src/items/agent/composer-logic.test.ts
import { beforeEach, describe, expect, test } from "vitest";
import { MAX_PIPE_LINE_BYTES } from "../../../src/shared/agent-protocol";
import {
  composerBlocks,
  fileUriForCandidate,
  promptFitsPipe,
  serializedPromptBytes,
} from "../../../src/web/agent/composer-logic";
import {
  getComposerDraft,
  resetComposerDraftStore,
  restoreComposerDraft,
  updateComposerDraft,
} from "../../../src/web/agent/composer-state";

beforeEach(resetComposerDraftStore);

describe("composer prompt bounds", () => {
  test("aggregate serialization rejects images that only fit one at a time", () => {
    const one = { type: "image" as const, data: "a".repeat(540_000), mimeType: "image/png" };
    expect(promptFitsPipe([one])).toBe(true);
    expect(promptFitsPipe([one, one])).toBe(false);
    expect(serializedPromptBytes([one, one])).toBeGreaterThan(MAX_PIPE_LINE_BYTES);
  });

  test("serialization counts UTF-8 bytes and the complete prompt envelope", () => {
    const blocks = composerBlocks("🧑‍💻", []);
    expect(serializedPromptBytes(blocks)).toBeGreaterThan(JSON.stringify(blocks).length);
  });
});

describe("file candidate paths", () => {
  test("resolves a relative machine path and percent-encodes URI segments", () => {
    expect(fileUriForCandidate(
      { name: "main file.ts", path: "src/main file.ts" },
      { resourceCwd: "/projects/project" },
    )).toBe("file:///projects/project/src/main%20file.ts");
  });

  test("uses native Windows paths without introducing renderer cloud paths", () => {
    expect(fileUriForCandidate({ name: "main.ts", path: "C:\\work tree\\main.ts" }))
      .toBe("file:///C:/work%20tree/main.ts");
  });

  test("refuses renderer virtual paths even when supplied as a URI", () => {
    expect(fileUriForCandidate({
      name: "secret.ts",
      path: "/tmp/secret.ts",
      uri: "file:///@cloud/repo/secret.ts",
    })).toBeNull();
    expect(fileUriForCandidate({ name: "secret.ts", path: "/@cloud/repo/secret.ts" })).toBeNull();
  });
});

describe("external draft restoration", () => {
  test("prepends queued content while preserving unsent text and attachments", () => {
    const existing = { type: "image" as const, data: "old", mimeType: "image/png" };
    updateComposerDraft("item", { text: "new work", attachments: [existing], focusRevision: 0 });
    const restored = { type: "image" as const, data: "queued", mimeType: "image/png" };
    restoreComposerDraft("item", [
      { type: "text", text: "queued text" },
      restored,
      { type: "resource_link", name: "a.ts", uri: "file:///repo/a.ts" },
    ]);

    expect(getComposerDraft("item")).toEqual({
      text: "queued text\nnew work",
      attachments: [
        restored,
        { type: "resource_link", name: "a.ts", uri: "file:///repo/a.ts" },
        existing,
      ],
      focusRevision: 1,
    });
  });
});
