// Adapted from cube-computer: src/windows/app/src/items/agent/conversation-logic.ts
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { parseCloudPath } from "./path-utils";
import type { Turn } from "./transcript";

export interface ConversationPathContext { rendererCwd: string; nativeCwd: string | null }

function normalize(path: string): string {
  const prefix = /^[A-Za-z]:/.exec(path)?.[0] ?? "";
  const parts: string[] = [];
  for (const part of path.replaceAll("\\", "/").slice(prefix.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `${prefix}/${parts.join("/")}`;
}
function under(path: string, root: string): boolean { return path === root || path.startsWith(`${root.replace(/\/$/, "")}/`); }
function nativeRoot(context: ConversationPathContext): { repoId: string; root: string } | null {
  const cloud = parseCloudPath(context.rendererCwd);
  if (!cloud || !context.nativeCwd) return null;
  const cwd = normalize(context.nativeCwd);
  const suffix = cloud.rel ? `/${cloud.rel}` : "";
  if (suffix && !cwd.endsWith(suffix)) return null;
  return { repoId: cloud.repoId, root: suffix ? cwd.slice(0, -suffix.length) || "/" : cwd };
}

/** Mention candidates enter as renderer paths. An unknown remote root is
 * a disabled candidate, never a fabricated file:///@cloud URI. */
export function nativePathFor(path: string, context: ConversationPathContext): string | null {
  if (!path.startsWith("/@cloud/")) return normalize(path);
  const cloud = parseCloudPath(path);
  const base = nativeRoot(context);
  if (!cloud || !base || cloud.repoId !== base.repoId) return null;
  return normalize(`${base.root}/${cloud.rel}`);
}

/** Tools report machine paths. Only map a cloud file when the session's
 * repository root is known and actually contains it. */
export function rendererPathFor(path: string, context: ConversationPathContext): string | null {
  if (/^file:/i.test(path)) {
    try {
      const url = new URL(path);
      if (url.hostname && url.hostname !== "localhost") return null;
      path = decodeURIComponent(url.pathname);
      if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
    } catch { return null; }
  }
  if (path.includes("\0")) return null;
  const absolute = /^(?:\/|[A-Za-z]:[\\/])/.test(path);
  const native = normalize(absolute ? path : `${context.nativeCwd ?? context.rendererCwd}/${path}`);
  if (!context.rendererCwd.startsWith("/@cloud/")) return native;
  const base = nativeRoot(context);
  if (!base || !under(native, base.root)) return null;
  const relative = native.slice(base.root === "/" ? 1 : base.root.length).replace(/^\//, "");
  return `/@cloud/${base.repoId}${relative ? `/${relative}` : ""}`;
}

export function contentText(block: ContentBlock): string {
  if (block.type === "text") return block.text;
  if (block.type === "resource_link") return `[${block.title ?? block.name}](${block.uri})`;
  if (block.type === "resource") {
    return "text" in block.resource ? block.resource.text : `[Resource: ${block.resource.uri}]`;
  }
  if (block.type === "image") return "[Image]";
  if (block.type === "audio") return "[Audio]";
  return "[Content]";
}
export function promptLabel(blocks: ContentBlock[]): string {
  return blocks.map(contentText).join(" ").replace(/\s+/g, " ").trim();
}
export function searchableToolText(call: Extract<Turn["blocks"][number], { kind: "tool" }>["call"]): string {
  const raw = [call.rawInput, call.rawOutput].map((value) => {
    if (value === undefined) return "";
    try { return typeof value === "string" ? value : JSON.stringify(value); } catch { return ""; }
  });
  return [call.title, ...raw, ...call.locations.map((location) => location.path), ...call.content.map((content) => {
    if (content.type === "content") return contentText(content.content);
    if (content.type === "diff") return `${content.path}\n${content.oldText ?? ""}\n${content.newText}`;
    if (content.type === "terminal") return `Terminal ${content.terminalId}`;
    return "Unsupported tool content";
  })].join("\n");
}
function turnText(turn: Turn): string {
  return [turn.user.map(contentText).join("\n"), ...turn.blocks.map((block) => {
    if (block.kind === "text" || block.kind === "thought") return block.text;
    if (block.kind === "tool") return searchableToolText(block.call);
    if (block.kind === "plan") return block.entries.map((entry) => entry.content).join("\n");
    return contentText(block.content);
  }), turn.error ?? ""].join("\n");
}
export function searchTurns(turns: Turn[], query: string): string[] {
  const needle = query.trim().toLocaleLowerCase();
  return needle ? turns.filter((turn) => turnText(turn).toLocaleLowerCase().includes(needle)).map((turn) => turn.id) : [];
}
export function transcriptMarkdown(turns: Turn[], title: string): string {
  const pieces = [`# ${title.replace(/[\r\n]/g, " ")}`];
  for (const turn of turns) {
    if (turn.user.length) pieces.push("## You", turn.user.map(contentText).join("\n\n"));
    pieces.push("## Agent");
    for (const block of turn.blocks) {
      if (block.kind === "text") pieces.push(block.text);
      else if (block.kind === "thought") pieces.push(`### Reasoning\n\n${block.text}`);
      else if (block.kind === "content") pieces.push(contentText(block.content));
      else if (block.kind === "plan") pieces.push(block.entries.map((entry) => `- [${entry.status === "completed" ? "x" : " "}] ${entry.content}`).join("\n"));
      else pieces.push(`### ${block.call.title || "Tool"} (${block.call.status})\n\n${searchableToolText(block.call)}`);
    }
    if (turn.error) pieces.push(`Error: ${turn.error}`);
    else if (turn.end && turn.end !== "end_turn") pieces.push(`Turn ended: ${turn.end}`);
  }
  return `${pieces.join("\n\n")}\n`;
}
