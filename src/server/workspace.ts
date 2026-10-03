// What the workspace list shows for one persona: its known repositories
// (the context folder's `## Repositories` block, in file order — one that is
// gone is listed `stale`), then every other repository a worker of this
// persona runs in. A repository's checkouts are its own root (for a known
// one) and every checkout a worker runs in, grouped by git's common
// directory so a linked worktree sits under the repository it belongs to.
// Artifacts are the regular `.html` files directly at a checkout's root and
// at the context folder's root — where the artifact instruction tells
// workers and the persona to write them.
import { execFile } from "node:child_process";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { AgentReport, Worker, WorkspaceTree } from "../shared/types";
import { readKnownRoots } from "./context-folder";
import { contextFolderOf } from "./paths";
import { assertPersonaId } from "./state";

export type { WorkspaceTree } from "../shared/types";

type Repo = WorkspaceTree["repos"][number];
type Checkout = Repo["checkouts"][number];
type Artifact = Checkout["artifacts"][number];

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;

/** Where a folder sits in git: its checkout's root and the repository's common directory, both real paths. */
interface Placement {
  checkout: string;
  commonDir: string | null;
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { timeout: GIT_TIMEOUT_MS });
    const out = stdout.trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

async function real(path: string): Promise<string> {
  try { return await realpath(path); } catch { return path; }
}

/** The real root of the git checkout `dir` is in, or null when it is in none (or is gone). */
export async function gitCheckoutRootOf(dir: string): Promise<string | null> {
  if (!(await isDirectory(dir))) return null;
  const top = await git(dir, ["rev-parse", "--show-toplevel"]);
  return top === null ? null : real(top);
}

/** A folder that is not in a git checkout is a checkout of its own with no repository. */
async function placementOf(dir: string): Promise<Placement> {
  const top = await git(dir, ["rev-parse", "--show-toplevel"]);
  if (top === null) return { checkout: await real(dir), commonDir: null };
  const common = await git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return { checkout: await real(top), commonDir: common === null ? null : await real(common) };
}

/** The checked-out branch, or null when HEAD is detached or the folder is no checkout. */
function branchOf(checkout: string): Promise<string | null> {
  return git(checkout, ["symbolic-ref", "--short", "-q", "HEAD"]);
}

/** A repository's main folder: the parent of a `.git` common directory, else (bare) the directory itself. */
function repoRootOf(commonDir: string): string {
  return basename(commonDir) === ".git" ? dirname(commonDir) : commonDir;
}

/** Regular `.html` files directly in `dir` (a symlink is not one), sorted by name. */
export async function artifactsIn(dir: string): Promise<Artifact[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".html"))
    .map((e) => e.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((name) => ({ path: join(dir, name), name }));
}

interface Group {
  repo: Repo;
  /** Real checkout path → the checkout entry. */
  checkouts: Map<string, Checkout>;
}

/**
 * `workers` is every worker the app knows (only this persona's are used);
 * `latestReport` gives each one's latest report, whose text the list shows.
 */
export async function workspaceOf(
  personaId: string,
  workers: readonly Worker[],
  latestReport: (agentId: string) => AgentReport | null = () => null,
): Promise<WorkspaceTree> {
  assertPersonaId(personaId);
  const folder = contextFolderOf(personaId);
  const groups: Group[] = [];
  // An exit or an interruption has no text: the list then shows none.
  const listed = (worker: Worker): Checkout["workers"][number] => ({ ...worker, latestReport: latestReport(worker.id)?.text || null });
  /** Common directory (or, outside git, the real checkout path) → its group. */
  const byKey = new Map<string, Group>();
  /** A known root's real path → its group, so a worker there lands under that root even when two known roots share a repository. */
  const byKnownCheckout = new Map<string, Group>();

  const addCheckout = (group: Group, realRoot: string, root: string): Checkout => {
    let checkout = group.checkouts.get(realRoot);
    if (!checkout) {
      checkout = { root, branch: null, workers: [], artifacts: [] };
      group.checkouts.set(realRoot, checkout);
      group.repo.checkouts.push(checkout);
    }
    return checkout;
  };

  for (const root of await readKnownRoots(folder).catch(() => [])) {
    const repo: Repo = { root, name: basename(root), known: true, stale: false, checkouts: [] };
    const group: Group = { repo, checkouts: new Map() };
    groups.push(group);
    if (!(await isDirectory(root))) {
      repo.stale = true;
      continue;
    }
    const placement = await placementOf(root);
    const key = placement.commonDir ?? placement.checkout;
    if (!byKey.has(key)) byKey.set(key, group);
    const realRoot = await real(root);
    if (!byKnownCheckout.has(realRoot)) byKnownCheckout.set(realRoot, group);
    addCheckout(group, realRoot, root);
  }

  for (const worker of workers) {
    if (worker.personaId !== personaId) continue;
    if (!(await isDirectory(worker.cwd))) {
      // Its folder is gone: still listed, so the person can see and stop it.
      const key = `gone:${worker.cwd}`;
      let group = byKey.get(key);
      if (!group) {
        group = { repo: { root: worker.cwd, name: basename(worker.cwd), known: false, stale: true, checkouts: [] }, checkouts: new Map() };
        byKey.set(key, group);
        groups.push(group);
      }
      addCheckout(group, worker.cwd, worker.cwd).workers.push(listed(worker));
      continue;
    }
    const placement = await placementOf(worker.cwd);
    const key = placement.commonDir ?? placement.checkout;
    let group = byKnownCheckout.get(placement.checkout) ?? byKey.get(key);
    if (!group) {
      const root = placement.commonDir === null ? placement.checkout : repoRootOf(placement.commonDir);
      group = { repo: { root, name: basename(root), known: false, stale: false, checkouts: [] }, checkouts: new Map() };
      byKey.set(key, group);
      groups.push(group);
    }
    addCheckout(group, placement.checkout, placement.checkout).workers.push(listed(worker));
  }

  await Promise.all(groups.flatMap((g) => g.repo.checkouts.map(async (checkout) => {
    if (g.repo.stale) return;
    const [branch, artifacts] = await Promise.all([branchOf(checkout.root), artifactsIn(checkout.root)]);
    checkout.branch = branch;
    checkout.artifacts = artifacts;
  })));

  return {
    repos: groups.map((g) => g.repo),
    contextFolder: { path: folder, artifacts: await artifactsIn(folder) },
  };
}
