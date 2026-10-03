// Adapted from cube-computer: src/windows/app/src/items/agent/composer-state.test.ts
// @vitest-environment happy-dom
import { afterAll, beforeEach, expect, test } from "vitest";
import { clearSentComposerDraft, composerDraftKey, getComposerDraft, persistComposerDrafts, reloadWithComposerDrafts, resetComposerDraftStore, updateComposerDraft } from "../../../src/web/agent/composer-state";

beforeEach(() => { sessionStorage.clear(); resetComposerDraftStore(); });

const key = composerDraftKey("account-a", "machine-a", "item-a");
const draft = { text: "Unsent work", attachments: [
  { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" },
  { type: "resource_link" as const, uri: "file:///home/user/report.txt", name: "report.txt" },
], focusRevision: 2 };

test("recovery reload preserves text and attachment blocks scoped to account, machine, and item", () => {
  updateComposerDraft(key, draft);
  const hidden = composerDraftKey("account-a", "machine-b", "hidden-item");
  updateComposerDraft(hidden, { ...draft, text: "Hidden composer" });
  let reloaded = false;
  reloadWithComposerDrafts("machine-a", "bundle", sessionStorage, () => {
    reloaded = true;
    resetComposerDraftStore(); // A new page has no in-memory drafts.
    expect(getComposerDraft(key)).toEqual(draft);
    expect(getComposerDraft(hidden).text).toBe("Hidden composer");
    for (const other of [composerDraftKey("account-b", "machine-a", "item-a"), composerDraftKey("account-a", "machine-b", "item-a"), composerDraftKey("account-a", "machine-a", "item-b")]) {
      expect(getComposerDraft(other).text).toBe("");
      expect(getComposerDraft(other).attachments).toEqual([]);
    }
  });
  expect(reloaded).toBe(true);
  expect(sessionStorage.getItem("cube.reload.machine-a.bundle")).toBe("1");
});

test("a consecutive recovery retains drafts not mounted yet; sent snapshots do not resurrect", () => {
  updateComposerDraft(key, draft);
  persistComposerDrafts();
  resetComposerDraftStore();
  persistComposerDrafts();
  resetComposerDraftStore();
  const restored = getComposerDraft(key);
  expect(restored).toEqual(draft);
  clearSentComposerDraft(key, restored);
  resetComposerDraftStore();
  expect(getComposerDraft(key).text).toBe("");
});

test("failed persistence leaves live input and the reload guard untouched", () => {
  updateComposerDraft(key, draft);
  const writes: string[] = [];
  const storage = { getItem: () => null, setItem: (key: string) => { writes.push(key); throw new Error("quota exceeded"); } } as unknown as Storage;
  expect(() => reloadWithComposerDrafts("machine-a", "bundle", storage, () => { throw new Error("must not navigate"); })).toThrow("quota exceeded");
  expect(writes).toEqual(["cube.composer-recovery.v1"]);
  expect(getComposerDraft(key)).toEqual(draft);
  expect(sessionStorage.getItem("cube.reload.machine-a.bundle")).toBeNull();
});

for (const editAfterCancel of [false, true]) test(`cancelled recovery reload cannot resurrect a sent draft (edited=${editAfterCancel})`, () => {
  updateComposerDraft(key, draft);
  reloadWithComposerDrafts("machine-a", "bundle", sessionStorage, () => { /* User cancels beforeunload. */ });
  if (editAfterCancel) updateComposerDraft(key, current => ({ ...current, text: current.text + " edited" }));
  const sent = getComposerDraft(key);
  clearSentComposerDraft(key, sent);
  resetComposerDraftStore(); // Later manual refresh.
  expect(getComposerDraft(key).text).toBe("");
  expect(getComposerDraft(key).attachments).toEqual([]);
});
