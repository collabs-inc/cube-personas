// Adapted from cube-computer: src/windows/app/src/items/agent/composer-logic.ts
import type { AvailableCommand, ContentBlock } from "@agentclientprotocol/sdk";
import { MAX_PIPE_LINE_BYTES } from "../../shared/agent-protocol";

export interface FileCandidate {
  name: string;
  /** Machine-native absolute path, or a path relative to resourceCwd/resourceRoot. */
  path: string;
  /** An already translated machine-native URI. Renderer /@cloud URIs are rejected. */
  uri?: string | undefined;
}

export type ComposerAttachment = Exclude<ContentBlock, { type: "text" }>;

export interface ComposerImage {
  data: string;
  mimeType: string;
  name?: string | undefined;
}

export interface MentionQuery {
  start: number;
  end: number;
  query: string;
}

const encoder = new TextEncoder();
const SIZE_REQUEST_ID = "page:composer-size-check";
// Session ids are adapter-owned. Reserve a deliberately generous width so
// the component cannot approve a prompt that the real JSON-RPC envelope
// then pushes over the pipe's one-line limit.
const SIZE_SESSION_ID = "s".repeat(256);

export function composerBlocks(text: string, attachments: ComposerAttachment[]): ContentBlock[] {
  const trimmed = text.trim();
  return [
    ...(trimmed === "" ? [] : [{ type: "text" as const, text: trimmed }]),
    ...attachments,
  ];
}

/** Bytes the server will write for a representative, conservatively sized prompt request. */
export function serializedPromptBytes(blocks: ContentBlock[]): number {
  const message = {
    jsonrpc: "2.0",
    id: SIZE_REQUEST_ID,
    method: "session/prompt",
    params: { sessionId: SIZE_SESSION_ID, prompt: blocks },
  };
  return encoder.encode(`${JSON.stringify(message)}\n`).byteLength;
}

export function promptFitsPipe(blocks: ContentBlock[]): boolean {
  return serializedPromptBytes(blocks) <= MAX_PIPE_LINE_BYTES;
}

export function promptSizeMessage(blocks: ContentBlock[]): string | null {
  if (promptFitsPipe(blocks)) return null;
  const kib = Math.ceil(serializedPromptBytes(blocks) / 1024);
  return `This prompt is ${kib.toLocaleString()} KB. Remove some text or attachments to stay under 1 MB.`;
}

export function filterCommands(text: string, commands: AvailableCommand[]): AvailableCommand[] {
  if (!text.startsWith("/")) return [];
  const query = text.slice(1);
  if (/\s/.test(query)) return [];
  const lower = query.toLocaleLowerCase();
  return commands.filter((command) => command.name.toLocaleLowerCase().startsWith(lower));
}

export function commandArgumentHint(text: string, commands: AvailableCommand[]): string | null {
  const match = /^\/([^\s]+)\s*$/.exec(text);
  if (!match || !text.includes(" ")) return null;
  const command = commands.find((candidate) => candidate.name === match[1]);
  return command?.input?.hint?.trim() || null;
}

/** The @word containing the caret. File paths with spaces arrive after selection. */
export function mentionQuery(text: string, cursor = text.length): MentionQuery | null {
  const safeCursor = Math.max(0, Math.min(cursor, text.length));
  const before = text.slice(0, safeCursor);
  const match = /(?:^|\s)@([^\s@]*)$/.exec(before);
  if (!match) return null;
  const at = before.lastIndexOf("@");
  return { start: at, end: safeCursor, query: match[1] ?? "" };
}

function isCloudValue(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  return normalized === "/@cloud"
    || normalized.endsWith("/@cloud")
    || normalized.includes("/@cloud/");
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(path);
}

function joinNative(base: string, relative: string): string {
  const separator = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return `${base.replace(/[\\/]$/, "")}${separator}${relative.replace(/^[\\/]/, "")}`;
}

function encodePathSegments(path: string): string {
  return path.split("/").map((part) => encodeURIComponent(part)).join("/");
}

export function fileUriForCandidate(
  candidate: FileCandidate,
  context: { resourceRoot?: string | undefined; resourceCwd?: string | undefined } = {},
): string | null {
  const supplied = candidate.uri?.trim();
  if (supplied) {
    if (isCloudValue(supplied)) return null;
    try {
      const uri = new URL(supplied);
      return uri.href;
    } catch {
      // Some file providers return an absolute path in the URI field. It
      // is safe to handle it through the same path conversion below.
      if (!isAbsolutePath(supplied)) return null;
    }
  }

  let path = supplied || candidate.path.trim();
  if (path === "" || isCloudValue(path) || path.includes("\0")) return null;
  if (!isAbsolutePath(path)) {
    const base = context.resourceCwd ?? context.resourceRoot;
    if (!base || isCloudValue(base)) return null;
    path = joinNative(base, path);
  }
  const normalized = path.replaceAll("\\", "/");
  if (/^[A-Za-z]:\//.test(normalized)) {
    const drive = normalized.slice(0, 2);
    return `file:///${drive}/${encodePathSegments(normalized.slice(3))}`;
  }
  if (normalized.startsWith("//")) {
    const withoutSlashes = normalized.slice(2);
    const slash = withoutSlashes.indexOf("/");
    const host = slash === -1 ? withoutSlashes : withoutSlashes.slice(0, slash);
    const rest = slash === -1 ? "" : withoutSlashes.slice(slash + 1);
    return `file://${host}${rest ? `/${encodePathSegments(rest)}` : ""}`;
  }
  return `file://${encodePathSegments(normalized)}`;
}

export function resourceLinkForCandidate(
  candidate: FileCandidate,
  context: { resourceRoot?: string | undefined; resourceCwd?: string | undefined } = {},
): Extract<ContentBlock, { type: "resource_link" }> | null {
  const uri = fileUriForCandidate(candidate, context);
  if (!uri) return null;
  return { type: "resource_link", name: candidate.name, title: candidate.path, uri };
}

export function insertMentionPath(text: string, mention: MentionQuery, path: string): string {
  return `${text.slice(0, mention.start)}${path}${text.slice(mention.end)}`;
}

export function isSupportedImageFile(file: File): boolean {
  return ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type.toLocaleLowerCase());
}
