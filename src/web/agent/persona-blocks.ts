// Adapted from cube-computer: src/windows/app/src/persona/PersonaEventLines.tsx (isCarriedReportsBlock, shownUserBlocks)
import type { ContentBlock } from "@agentclientprotocol/sdk";

/** The wake-up text's opening; the same words as `WAKE_UP_PREFIX` in src/server/reports/wake-ups.ts. */
export const WAKE_UP_PREFIX = "Worker reports.";

/** A server-appended block of worker reports carried inside a prompt. */
export function isCarriedReportsBlock(block: ContentBlock): boolean {
  const cube = block._meta?.cube;
  return typeof cube === "object" && cube !== null && "carriedReports" in cube
    && Array.isArray(cube.carriedReports);
}

/**
 * The user blocks a turn shows. A `session/load` replay drops a carried
 * block's `_meta`, so after a turn's first block the wake-up's own opening
 * marks it instead; as the first block it IS the turn — a wake-up — and shows.
 */
export function shownUserBlocks(user: readonly ContentBlock[]): ContentBlock[] {
  return user.filter((block, index) => !isCarriedReportsBlock(block)
    && !(index > 0 && block.type === "text" && block.text.startsWith(WAKE_UP_PREFIX)));
}
