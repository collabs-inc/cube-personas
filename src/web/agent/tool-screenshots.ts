// Adapted from cube-computer: src/windows/app/src/items/agent/tool-screenshots.ts
import type { ToolCallState } from "./transcript";
import { parseCloudPath } from "./path-utils";
import { isBrowserPreviewImage } from "./browser-image";
import { rendererPathFor, type ConversationPathContext } from "./conversation-logic";

export type ScreenshotReference = { nativePath: string; rendererPath: string };
export type ResolveScreenshot = (nativePath: string) => ScreenshotReference | null;
export type LoadScreenshot = (rendererPath: string) => Promise<{ url: string; width: number; height: number }>;

const MAX_DEPTH = 32;
const MAX_NODES = 10_000;
const MARKDOWN_SCREENSHOT = /\[Screenshot\]\((file:\/\/[^)]+)\)/gi;

function normalizeNativePath(value: string): string | null {
  try {
    let path = value;
    if (/^file:/i.test(value)) {
      const url = new URL(value);
      if (url.hostname && url.hostname !== "localhost") return null;
      path = decodeURIComponent(url.pathname);
    }
    if (!/^(?:\/|[A-Za-z]:[\\/])/.test(path) || path.includes("\0")) return null;
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
    const prefix = /^[A-Za-z]:/.exec(path)?.[0] ?? "";
    const parts: string[] = [];
    for (const part of path.replaceAll("\\", "/").slice(prefix.length).split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") parts.pop();
      else parts.push(part);
    }
    return `${prefix}/${parts.join("/")}`;
  } catch { return null; }
}

function screenshotUris(text: string): string[] {
  return Array.from(text.matchAll(MARKDOWN_SCREENSHOT), match => match[1]!);
}

function rawOutputUris(value: unknown): string[] {
  const result: string[] = [];
  const queue: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let visited = 0;
  while (visited < queue.length && visited < MAX_NODES) {
    const current = queue[visited++]!;
    if (typeof current.value === "string") { result.push(...screenshotUris(current.value)); continue; }
    if (typeof current.value !== "object" || current.value === null || current.depth >= MAX_DEPTH) continue;
    if (seen.has(current.value)) continue;
    seen.add(current.value);
    for (const key in current.value) {
      if (queue.length >= MAX_NODES) break;
      if (Object.hasOwn(current.value, key)) queue.push({ value: (current.value as Record<string, unknown>)[key], depth: current.depth + 1 });
    }
  }
  return result;
}

export function screenshotReferences(call: ToolCallState, resolve: ResolveScreenshot): ScreenshotReference[] {
  const candidates: string[] = [];
  for (const item of call.content) {
    if (item.type !== "content") continue;
    const content = item.content;
    if (content.type === "text") candidates.push(...screenshotUris(content.text));
    if (content.type === "resource_link" && /^image\//i.test(content.mimeType ?? "") && /^file:/i.test(content.uri)) candidates.push(content.uri);
  }
  if (call.rawOutput !== undefined) candidates.push(...rawOutputUris(call.rawOutput));
  const result: ScreenshotReference[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const nativePath = normalizeNativePath(candidate);
    if (!nativePath) continue;
    const reference = resolve(nativePath);
    if (!reference || seen.has(reference.nativePath)) continue;
    seen.add(reference.nativePath);
    result.push(reference);
  }
  return result;
}

export function createScreenshotResolver(context: ConversationPathContext, conversationId: string, checkoutRoot?: string): ResolveScreenshot {
  const cloud = parseCloudPath(context.rendererCwd);
  const root = cloud ? `/@cloud/${cloud.repoId}` : normalizeNativePath(checkoutRoot ?? context.rendererCwd);
  const prefix = root ? `${root.replace(/\/$/, "")}/.cube/screenshots/${conversationId}/` : null;
  return (path) => {
    const nativePath = normalizeNativePath(path);
    if (!nativePath || !isBrowserPreviewImage(nativePath)) return null;
    const rendererPath = rendererPathFor(nativePath, context);
    if (!rendererPath || !prefix || !rendererPath.startsWith(prefix)) return null;
    return { nativePath, rendererPath };
  };
}
