// The page's way into a persona's files: the artifact route and the
// `files:list` / `files:read` verbs. Every path comes from the browser, so
// each is confined: it must be absolute, carry no `..` segment, and resolve
// (after `realpath`, so a symlink is followed to where it really points)
// to one of the persona's allowed roots or somewhere under one — its known
// repositories, the git checkouts its workers run in, and its context
// folder. Anything else is simply not there: the route answers 404, the
// verbs one sentence that says nothing about why.
//
// A check by path and a later open by path can see different files (a
// folder swapped for a symlink in between), so the check is repeated on
// what was actually opened: the open descriptor's own path, and every read
// goes through that descriptor, never the path again.
import { constants, existsSync, type Stats } from "node:fs";
import { open, readdir, readlink, realpath, stat, type FileHandle } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import type { Worker } from "../shared/types";
import { readKnownRoots } from "./context-folder";
import { UserFacingError } from "./errors";
import type { Handler } from "./http";
import { contextFolderOf } from "./paths";
import { assertPersonaId } from "./state";
import { gitCheckoutRootOf } from "./workspace";

/** `files:read` returns at most this many bytes of a file. */
export const READ_CAP_BYTES = 1024 * 1024;
export const FILE_UNAVAILABLE = "That file is not available.";
export const FOLDER_UNAVAILABLE = "That folder is not available.";

/** Where an open descriptor's path can be read back (Linux). */
const FD_DIR = "/proc/self/fd";
const HAS_FD_DIR = existsSync(FD_DIR);
/** Never block on a FIFO, never take a terminal, never follow a symlink in the last component. */
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY | constants.O_NOFOLLOW;

export const TOO_BROAD_ROOT = "The filesystem root and your home folder cannot be listed as repositories.";

/**
 * True for `/` and the home folder itself: as a root, either would open
 * every file the page can name, so neither is ever one.
 */
export function tooBroadRoot(path: string): boolean {
  const normal = resolve(path);
  return normal === sep || normal === resolve(homedir());
}

/**
 * The known roots, the git checkout roots the persona's workers run in, and
 * the context folder. A worker folder outside any git checkout adds nothing.
 * The filesystem root and the home folder are never roots, even when listed
 * or when the home folder is itself a git checkout.
 */
export async function allowedRoots(personaId: string, workers: readonly Worker[]): Promise<string[]> {
  assertPersonaId(personaId);
  const folder = contextFolderOf(personaId);
  const roots = new Set<string>(await readKnownRoots(folder).catch(() => []));
  const checkouts = await Promise.all(
    workers.filter((w) => w.personaId === personaId).map((w) => gitCheckoutRootOf(w.cwd)),
  );
  for (const root of checkouts) if (root !== null) roots.add(root);
  for (const root of roots) if (tooBroadRoot(root)) roots.delete(root);
  roots.add(folder);
  return [...roots];
}

/** The roots' real paths; one that cannot be resolved is dropped. */
async function realRoots(roots: readonly string[]): Promise<string[]> {
  const found = await Promise.all(roots.map((r) => realpath(r).catch(() => null)));
  return found.filter((r): r is string => r !== null);
}

function within(target: string, reals: readonly string[]): boolean {
  return reals.some((root) => target === root || target.startsWith(root.endsWith(sep) ? root : root + sep));
}

function lexicallyAcceptable(path: unknown): path is string {
  return typeof path === "string" && path !== "" && !path.includes("\0") && isAbsolute(path) && !path.split("/").includes("..");
}

/**
 * The real path of `path` when it is absolute, has no `..` segment and
 * resolves to a root or under one; null otherwise (including when it does
 * not exist). A check only: what is read must come from `openInside`.
 */
export async function resolveInside(path: unknown, roots: readonly string[]): Promise<string | null> {
  if (!lexicallyAcceptable(path)) return null;
  let target: string;
  try {
    target = await realpath(path);
  } catch {
    return null;
  }
  return within(target, await realRoots(roots)) ? target : null;
}

export interface Opened {
  handle: FileHandle;
  /** The opened file's real path, as read back from the descriptor. */
  real: string;
  info: Stats;
}

/**
 * Opens `path` only once it checks out, then checks again what was opened:
 * the descriptor's own path must still be inside a root and be the file the
 * check saw. Null (nothing left open) otherwise. `beforeOpen` is a test hook
 * into the window between the check and the open.
 */
export async function openInside(
  path: unknown,
  roots: readonly string[],
  hooks: { beforeOpen?: () => Promise<void> } = {},
): Promise<Opened | null> {
  const checked = await resolveInside(path, roots);
  if (checked === null) return null;
  await hooks.beforeOpen?.();
  let handle: FileHandle;
  try {
    handle = await open(checked, OPEN_FLAGS);
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    const reals = await realRoots(roots);
    let real: string;
    if (HAS_FD_DIR) {
      real = await readlink(`${FD_DIR}/${handle.fd}`);
    } else {
      // No descriptor path to read: the path must still resolve inside, to this very file.
      real = await realpath(checked);
      const now = await stat(real);
      if (now.dev !== info.dev || now.ino !== info.ino) throw new Error("replaced");
    }
    if (!within(real, reals)) throw new Error("outside");
    return { handle, real, info };
  } catch {
    await handle.close().catch(() => {});
    return null;
  }
}

export async function listFolder(path: unknown, roots: readonly string[]): Promise<{ entries: { name: string; dir: boolean }[] }> {
  const opened = await openInside(path, roots);
  if (opened === null) throw new UserFacingError(FOLDER_UNAVAILABLE);
  const { handle, real, info } = opened;
  try {
    if (!info.isDirectory()) throw new UserFacingError(FOLDER_UNAVAILABLE);
    // Through the descriptor where possible, so the folder listed is the one checked.
    const found = await readdir(HAS_FD_DIR ? `${FD_DIR}/${handle.fd}` : real, { withFileTypes: true });
    const entries = found.map((e) => ({ name: e.name, dir: e.isDirectory() }));
    entries.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { entries };
  } catch (err) {
    if (err instanceof UserFacingError) throw err;
    throw new UserFacingError(FOLDER_UNAVAILABLE);
  } finally {
    await handle.close().catch(() => {});
  }
}

/** The file's first READ_CAP_BYTES as UTF-8, never cut inside a character. */
export async function readTextFile(path: unknown, roots: readonly string[]): Promise<{ text: string; truncated: boolean }> {
  const opened = await openInside(path, roots);
  if (opened === null) throw new UserFacingError(FILE_UNAVAILABLE);
  const { handle, info } = opened;
  try {
    if (!info.isFile()) throw new UserFacingError(FILE_UNAVAILABLE);
    // One byte past the cap tells a file of exactly the cap from a longer one.
    const buf = Buffer.alloc(READ_CAP_BYTES + 1);
    let filled = 0;
    while (filled < buf.length) {
      const { bytesRead } = await handle.read(buf, filled, buf.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    const truncated = filled > READ_CAP_BYTES;
    let end = Math.min(filled, READ_CAP_BYTES);
    if (truncated) end = utf8Boundary(buf, end);
    return { text: buf.subarray(0, end).toString("utf8"), truncated };
  } catch (err) {
    if (err instanceof UserFacingError) throw err;
    throw new UserFacingError(FILE_UNAVAILABLE);
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Moves `end` back to the start of a UTF-8 sequence that `end` would split. */
function utf8Boundary(buf: Buffer, end: number): number {
  let start = end;
  // Step back over continuation bytes (at most three) to the sequence's lead byte.
  while (start > 0 && end - start < 4 && (buf[start - 1]! & 0xc0) === 0x80) start--;
  if (start === 0) return end;
  const lead = buf[start - 1]!;
  const length = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  // The sequence led by `lead` begins at start - 1; keep it only when it fits whole.
  return start - 1 + length <= end ? end : start - 1;
}

export interface ArtifactDeps {
  /** True for a persona that exists. */
  exists(personaId: string): boolean;
  roots(personaId: string): Promise<string[]>;
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end("Not found");
}

/**
 * `GET /artifact?persona=<id>&path=<abs>`: an `.html` file inside the
 * persona's roots, never cached. It is served with a CSP sandbox so that,
 * even opened outside the page's sandboxed frame, it runs in an opaque
 * origin and cannot act as the app's own page.
 */
export function artifactHandler(deps: ArtifactDeps): Handler {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const personaId = url.searchParams.get("persona") ?? "";
    const path = url.searchParams.get("path");
    let opened: Opened | null = null;
    try {
      if (deps.exists(personaId)) opened = await openInside(path, await deps.roots(personaId));
    } catch {
      opened = null;
    }
    if (opened === null) return notFound(res);
    const { handle, real, info } = opened;
    if (!info.isFile() || !real.toLowerCase().endsWith(".html")) {
      await handle.close().catch(() => {});
      return notFound(res);
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox allow-scripts allow-forms allow-popups allow-modals",
    });
    // From the descriptor that was checked, never the path again; the stream closes it.
    const stream = handle.createReadStream();
    await new Promise<void>((resolve) => {
      stream.once("error", () => {
        res.destroy();
        resolve();
      });
      res.once("close", () => {
        stream.destroy();
        resolve();
      });
      stream.pipe(res);
    });
  };
}
