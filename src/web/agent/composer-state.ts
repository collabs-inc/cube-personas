// Adapted from cube-computer: src/windows/app/src/items/agent/composer-state.ts
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { ComposerAttachment } from "./composer-logic";

export interface ComposerDraft {
  text: string;
  attachments: ComposerAttachment[];
  /** Incremented when an external caller asks the mounted composer to focus. */
  focusRevision: number;
}

const EMPTY_DRAFT: ComposerDraft = { text: "", attachments: [], focusRevision: 0 };
const drafts = new Map<string, ComposerDraft>();
const listeners = new Map<string, Set<() => void>>();

const RECOVERY_DRAFTS_KEY = "cube.composer-recovery.v1";
let loadedRecoveryDrafts = false;
let recoverySnapshotStorage: Storage | undefined;

/** JSON tuples keep account, machine, and item boundaries unambiguous. */
export function composerDraftKey(accountId: string | null, machineId: string, itemId: string): string {
  return JSON.stringify([accountId, machineId, itemId]);
}

function loadRecoveryDrafts(storage: Storage): void {
  if (loadedRecoveryDrafts) return;
  const raw = storage.getItem(RECOVERY_DRAFTS_KEY);
  if (raw !== null) {
    const entries: Array<[string, ComposerDraft]> = JSON.parse(raw);
    if (!Array.isArray(entries) || entries.some(entry => !Array.isArray(entry) || typeof entry[0] !== "string"
      || typeof entry[1]?.text !== "string" || !Array.isArray(entry[1]?.attachments))) {
      throw new Error("Could not restore saved composer drafts");
    }
    for (const [key, draft] of entries) {
      if (!drafts.has(key)) drafts.set(key, draft);
    }
    // Consume the snapshot once. A later recovery saves the whole live map
    // again; an ordinary refresh cannot resurrect a prompt already sent.
    storage.removeItem(RECOVERY_DRAFTS_KEY);
  }
  loadedRecoveryDrafts = true;
}

/** Save all composers, including hidden items and drafts restored but not mounted yet.
 * Throw on storage failure: recovery must keep the page and unsent input alive.
 */
export function persistComposerDrafts(storage: Storage = sessionStorage): void {
  loadRecoveryDrafts(storage);
  storage.setItem(RECOVERY_DRAFTS_KEY, JSON.stringify([...drafts]));
  recoverySnapshotStorage = storage;
}

/** Save before the guard is committed; a failed save must remain retryable. */
export function reloadWithComposerDrafts(machineId: string, daemonBundle: string, storage: Storage, reload: () => void): void {
  persistComposerDrafts(storage);
  storage.setItem(`cube.reload.${machineId}.${daemonBundle}`, "1");
  reload();
}

export function getComposerDraft(itemId: string): ComposerDraft {
  // Storage may be disabled. Reading a composer must still work; the reload
  // path performs the same read strictly and refuses navigation on failure.
  try { loadRecoveryDrafts(sessionStorage); } catch { /* Keep the live draft. */ }
  return drafts.get(itemId) ?? EMPTY_DRAFT;
}

export function subscribeComposerDraft(itemId: string, listener: () => void): () => void {
  let itemListeners = listeners.get(itemId);
  if (!itemListeners) {
    itemListeners = new Set();
    listeners.set(itemId, itemListeners);
  }
  itemListeners.add(listener);
  return () => {
    itemListeners!.delete(listener);
    if (itemListeners!.size === 0) listeners.delete(itemId);
  };
}

export function updateComposerDraft(
  itemId: string,
  update: ComposerDraft | ((draft: ComposerDraft) => ComposerDraft),
): void {
  const current = getComposerDraft(itemId);
  const next = typeof update === "function" ? update(current) : update;
  if (next === current) return;
  // Navigation may have been cancelled after saving. Invalidate the old
  // snapshot before accepting any later edit or send, so refresh cannot replay it.
  // A storage failure leaves the live draft unchanged and makes the edit retryable.
  recoverySnapshotStorage?.removeItem(RECOVERY_DRAFTS_KEY);
  recoverySnapshotStorage = undefined;
  drafts.set(itemId, next);
  for (const listener of listeners.get(itemId) ?? []) listener();
}

/**
 * Restores a queued prompt or suggestion without destroying work already in
 * the box. Restored content is prepended so its original ordering survives.
 */
export function restoreComposerDraft(
  itemId: string,
  blocks: ContentBlock[],
  options: { focus?: boolean | undefined } = {},
): void {
  const incomingText = blocks
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const incomingAttachments = blocks.filter(
    (block): block is ComposerAttachment => block.type !== "text",
  );
  updateComposerDraft(itemId, (current) => ({
    text: [incomingText, current.text].filter((part) => part !== "").join("\n"),
    attachments: [...incomingAttachments, ...current.attachments],
    focusRevision: current.focusRevision + (options.focus === false ? 0 : 1),
  }));
}

/** Clear only the snapshot that landed; edits made while sending survive. */
export function clearSentComposerDraft(itemId: string, sent: ComposerDraft): void {
  updateComposerDraft(itemId, (current) => {
    let text = current.text;
    if (text === sent.text) text = "";
    else if (sent.text !== "" && text.startsWith(sent.text)) text = text.slice(sent.text.length);
    const sentAttachments = [...sent.attachments];
    const attachments = current.attachments.filter((attachment) => {
      const index = sentAttachments.indexOf(attachment);
      if (index === -1) return true;
      sentAttachments.splice(index, 1);
      return false;
    });
    return { ...current, text, attachments };
  });
}

/** Test isolation; production drafts intentionally live for the renderer lifetime. */
export function resetComposerDraftStore(): void {
  drafts.clear();
  loadedRecoveryDrafts = false;
  recoverySnapshotStorage = undefined;
  for (const itemListeners of listeners.values()) {
    for (const listener of itemListeners) listener();
  }
}
