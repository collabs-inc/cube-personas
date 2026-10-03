// The repositories a persona can see: its known roots (the context folder's
// `## Repositories` block) first, in file order, then every git checkout one
// level under ~/repos. One entry per real path, so a symlinked alias of a
// repository already listed is dropped.
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { RepoEntry } from "../shared/types";
import { readKnownRoots } from "./context-folder";

export type { RepoEntry } from "../shared/types";

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

/** The real path, or the path as written when it cannot be resolved (a known root that is gone). */
async function identity(path: string): Promise<string> {
  try { return await realpath(path); } catch { return path; }
}

async function scanRepos(home: string): Promise<string[]> {
  const dir = join(home, "repos");
  let names: string[];
  try { names = await readdir(dir); } catch { return []; }
  const found: string[] = [];
  for (const name of names.sort()) {
    const path = join(dir, name);
    if (await isDirectory(path) && await exists(join(path, ".git"))) found.push(path);
  }
  return found;
}

export async function listRepos(home: string, contextDir: string): Promise<RepoEntry[]> {
  const candidates = [
    ...(await readKnownRoots(contextDir)).map((path) => ({ path, known: true })),
    ...(await scanRepos(home)).map((path) => ({ path, known: false })),
  ];
  const seen = new Set<string>();
  const entries: RepoEntry[] = [];
  for (const { path, known } of candidates) {
    const key = await identity(path);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ path, name: basename(path), known });
  }
  return entries;
}
