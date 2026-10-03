// Adapted from cube-computer: src/windows/app/src/items/agent/agent-item-logic.ts
/**
 * The pure half of the conversation view: everything `AgentItem` and its
 * children decide that does not need the DOM, a service or a clock.
 *
 * Same split as `terminal-item-logic.ts` beside it, for the same reason —
 * the component itself mounts xterm, subscribes to three streams and
 * scrolls a column, so anything testable that can be lifted out of it is.
 * Nothing here reads `services`, React or `window`.
 */
import type {
  AvailableCommand,
  ContentBlock,
  PlanEntry,
  ToolKind,
} from "@agentclientprotocol/sdk";
import type { Block } from "./transcript";

// -- scroll ---------------------------------------------------------------

/**
 * How close to the bottom the reader has to be for new output to keep
 * following them down. Generous enough that a resting scroll position a
 * few pixels off the floor (a sub-pixel row height, a rubber-band
 * overshoot) still counts as "at the bottom", small enough that a
 * deliberate scroll up releases immediately.
 */
export const STICK_SLACK_PX = 40;

export function shouldStickToBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): boolean {
  return scrollHeight - clientHeight - scrollTop <= STICK_SLACK_PX;
}

// -- folding a turn's blocks into segments --------------------------------

/**
 * What one turn renders as. Prose and plans speak for themselves; every
 * contiguous run of thinking and tool work collapses into ONE line the
 * reader can expand — which is the difference between a conversation and
 * a log.
 */
export type Segment =
  | { kind: "text"; text: string }
  | { kind: "content"; content: ContentBlock }
  | { kind: "plan"; entries: PlanEntry[] }
  | { kind: "activity"; summary: string; blocks: Block[]; running: number; failed: number };

/** How much of a tool's title the folded status line may spend. */
const TITLE_MAX = 48;

const VERBS: Record<ToolKind, { one: string; alone: string; many: (n: number) => string }> = {
  read: { one: "Read", alone: "Read a file", many: (n) => `Read ${n} files` },
  edit: { one: "Edited", alone: "Edited a file", many: (n) => `Edited ${n} files` },
  delete: { one: "Deleted", alone: "Deleted a file", many: (n) => `Deleted ${n} files` },
  move: { one: "Moved", alone: "Moved a file", many: (n) => `Moved ${n} files` },
  search: { one: "Searched", alone: "Searched", many: (n) => `Searched ${n} times` },
  execute: { one: "Ran", alone: "Ran a command", many: (n) => `Ran ${n} commands` },
  think: { one: "Considered", alone: "Considered", many: (n) => `Considered ${n} things` },
  fetch: { one: "Fetched", alone: "Fetched", many: (n) => `Fetched ${n} resources` },
  switch_mode: { one: "Switched to", alone: "Switched mode", many: (n) => `Switched mode ${n} times` },
  other: { one: "", alone: "1 step", many: (n) => `${n} steps` },
};

function ellipsize(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function phraseForOne(kind: ToolKind, title: string): string {
  const verb = VERBS[kind] ?? VERBS.other;
  const trimmed = title.trim();
  if (trimmed === "") return verb.alone;
  const short = ellipsize(trimmed, TITLE_MAX);
  return verb.one === "" ? short : `${verb.one} ${short}`;
}

/**
 * The one-line account of a folded run: "Thought · Read 3 files · Ran npm
 * test". Thinking is named once however many thought chunks arrived (they
 * are one train of thought, not three), and consecutive tools of the same
 * kind count up rather than listing every title — the point of the line is
 * to be skippable.
 */
export function summarizeRun(blocks: Block[]): string {
  const parts: string[] = [];
  if (blocks.some((b) => b.kind === "thought")) parts.push("Thought");
  let index = 0;
  while (index < blocks.length) {
    const block = blocks[index];
    if (!block || block.kind !== "tool") {
      index += 1;
      continue;
    }
    const kind = block.call.kind;
    let count = 0;
    while (index < blocks.length) {
      const next = blocks[index];
      if (!next || next.kind !== "tool" || next.call.kind !== kind) break;
      count += 1;
      index += 1;
    }
    const verb = VERBS[kind] ?? VERBS.other;
    parts.push(count === 1 ? phraseForOne(kind, block.call.title) : verb.many(count));
  }
  return parts.length > 0 ? parts.join(" · ") : "Working";
}

/**
 * Groups a turn's blocks into what the view renders. A run breaks on
 * anything that is not thinking or tool work — prose and plans are the
 * conversation, and folding them away would hide the answer inside the
 * summary of how it was reached.
 */
export function foldRuns(blocks: Block[]): Segment[] {
  const segments: Segment[] = [];
  let run: Block[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    const calls = run.filter((block) => block.kind === "tool");
    segments.push({
      kind: "activity",
      summary: summarizeRun(run),
      blocks: run,
      running: calls.filter((block) => block.call.status === "in_progress" || block.call.status === "pending").length,
      failed: calls.filter((block) => block.call.status === "failed").length,
    });
    run = [];
  };
  for (const block of blocks) {
    if (block.kind === "thought" || block.kind === "tool") {
      run.push(block);
      continue;
    }
    flush();
    if (block.kind === "text") segments.push({ kind: "text", text: block.text });
    else if (block.kind === "content") segments.push({ kind: "content", content: block.content });
    else segments.push({ kind: "plan", entries: block.entries });
  }
  flush();
  return segments;
}

// -- diffs ----------------------------------------------------------------

export interface DiffLine {
  kind: "context" | "add" | "remove" | "truncated";
  text: string;
}

/** The most lines a rendered diff may carry before it says it stopped. */
export const MAX_DIFF_LINES = 2000;

/**
 * The largest middle (old x new lines) the LCS is allowed to consider.
 * Beyond it the diff degrades to "all of this went, all of that arrived",
 * which is honest and instant; an unbounded table is quadratic MEMORY on
 * a file an agent rewrote wholesale.
 */
const LCS_CELL_BUDGET = 1_000_000;

function splitLines(text: string): string[] {
  if (text === "") return [];
  return text.replace(/\n$/, "").split("\n");
}

/**
 * A unified diff of two texts, line-level. Common prefix and suffix are
 * stripped first — an agent's edit is almost always local, and the LCS
 * then runs over a handful of lines instead of the whole file.
 *
 * `oldText` is nullable because the protocol's own `Diff.oldText` is: a
 * created file has none, and every line of it is an addition.
 */
export function unifiedLines(oldText: string | null | undefined, newText: string): DiffLine[] {
  const oldLines = splitLines(oldText ?? "");
  const newLines = splitLines(newText);

  let head = 0;
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < oldLines.length - head
    && tail < newLines.length - head
    && oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) {
    tail += 1;
  }

  const oldMid = oldLines.slice(head, oldLines.length - tail);
  const newMid = newLines.slice(head, newLines.length - tail);

  const out: DiffLine[] = [];
  for (let i = 0; i < head; i++) out.push({ kind: "context", text: oldLines[i]! });
  out.push(...diffMiddle(oldMid, newMid));
  for (let i = oldLines.length - tail; i < oldLines.length; i++) {
    out.push({ kind: "context", text: oldLines[i]! });
  }

  if (out.length <= MAX_DIFF_LINES) return out;
  const capped = out.slice(0, MAX_DIFF_LINES);
  capped.push({ kind: "truncated", text: "… truncated" });
  return capped;
}

function diffMiddle(oldMid: string[], newMid: string[]): DiffLine[] {
  if (oldMid.length === 0) return newMid.map((text) => ({ kind: "add" as const, text }));
  if (newMid.length === 0) return oldMid.map((text) => ({ kind: "remove" as const, text }));
  if ((oldMid.length + 1) * (newMid.length + 1) > LCS_CELL_BUDGET) {
    return [
      ...oldMid.map((text) => ({ kind: "remove" as const, text })),
      ...newMid.map((text) => ({ kind: "add" as const, text })),
    ];
  }

  const rows = oldMid.length + 1;
  const cols = newMid.length + 1;
  const table = new Int32Array(rows * cols);
  for (let i = oldMid.length - 1; i >= 0; i--) {
    for (let j = newMid.length - 1; j >= 0; j--) {
      table[i * cols + j] = oldMid[i] === newMid[j]
        ? table[(i + 1) * cols + j + 1]! + 1
        : Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < oldMid.length && j < newMid.length) {
    if (oldMid[i] === newMid[j]) {
      out.push({ kind: "context", text: oldMid[i]! });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * cols + j]! >= table[i * cols + j + 1]!) {
      out.push({ kind: "remove", text: oldMid[i]! });
      i += 1;
    } else {
      out.push({ kind: "add", text: newMid[j]! });
      j += 1;
    }
  }
  while (i < oldMid.length) {
    out.push({ kind: "remove", text: oldMid[i]! });
    i += 1;
  }
  while (j < newMid.length) {
    out.push({ kind: "add", text: newMid[j]! });
    j += 1;
  }
  return out;
}

// -- the composer ---------------------------------------------------------

export interface ComposerImage {
  /** Base64, no data: prefix — what `ImageContent.data` is on the wire. */
  data: string;
  mimeType: string;
}

/**
 * The largest base64 payload one attachment may carry.
 *
 * A prompt is ONE line on the adapter's stdin, and the server refuses a line
 * over `MAX_PIPE_LINE_BYTES` (1 MiB). 700 KiB
 * leaves room for the JSON envelope, the message text, and a second small
 * attachment, and a phone photo downscaled to 1600px of JPEG lands far
 * under it. Refusing here rather than letting the server refuse is only about
 * WHERE the user is told: the composer can say it against the thumbnail
 * they just added, before they have written the message.
 */
export const MAX_ATTACHMENT_BASE64_BYTES = 700 * 1024;

/** Whether an attachment is past that cap — base64 length is its wire size. */
export function attachmentTooLarge(image: ComposerImage): boolean {
  return image.data.length > MAX_ATTACHMENT_BASE64_BYTES;
}

/**
 * What a composed message sends. Text first, then images, and an empty
 * result means there is nothing to send at all — which is what the send
 * button and the Enter key both gate on, rather than each testing the
 * textarea for themselves.
 */
export function composerBlocks(text: string, images: ComposerImage[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const trimmed = text.trim();
  if (trimmed !== "") blocks.push({ type: "text", text: trimmed });
  for (const image of images) {
    blocks.push({ type: "image", data: image.data, mimeType: image.mimeType });
  }
  return blocks;
}

/**
 * The slash-command popover's contents for what has been typed so far.
 * Only while the whole draft is one `/word`: once there is whitespace the
 * user is writing arguments, not choosing a command, and a popover over
 * the composer at that point is in the way.
 */
export function filterCommands(text: string, commands: AvailableCommand[]): AvailableCommand[] {
  if (!text.startsWith("/")) return [];
  const query = text.slice(1);
  if (/\s/.test(query)) return [];
  const lower = query.toLowerCase();
  return commands.filter((c) => c.name.toLowerCase().startsWith(lower));
}
