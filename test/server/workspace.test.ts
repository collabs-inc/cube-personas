import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { seedContextFolder, writeRepoBlockText } from "../../src/server/context-folder";
import { workspaceOf } from "../../src/server/workspace";
import type { AgentReport, Worker } from "../../src/shared/types";

let root = "";
let home = "";
let savedHome: string | undefined;
const personaId = randomUUID();

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "personas-workspace-")));
  home = join(root, "home");
  await mkdir(home);
  savedHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  await rm(root, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

async function repoWithCommit(dir: string, branch = "main"): Promise<string> {
  await mkdir(dir, { recursive: true });
  git(dir, "init", "-q", "-b", branch);
  await writeFile(join(dir, "README"), "x");
  git(dir, "add", "README");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

function worker(id: string, cwd: string, persona = personaId): Worker {
  return {
    id, personaId: persona, harness: "claude", cwd, title: id, sessionId: null, launchId: randomUUID(), pid: null,
    cmdline: null, state: "idle", createdAt: "2026-10-03T00:00:00.000Z", lastReportId: null,
  };
}

const contextFolder = (): string => join(home, ".cube", "personas", personaId);

test("known roots first in file order, a missing one stale, then the repositories workers run in, worktrees grouped", async () => {
  const a = await repoWithCommit(join(root, "a"));
  const tree = join(root, "a-feature");
  git(a, "worktree", "add", "-q", "-b", "feature", tree);
  const b = await repoWithCommit(join(root, "b"), "trunk");
  const gone = join(root, "gone");
  await seedContextFolder(contextFolder());
  await writeRepoBlockText(contextFolder(), `${gone}\n${a}`);
  await mkdir(join(tree, "src"));

  const workers = [
    worker("w-tree", join(tree, "src")),
    worker("w-b", b),
    worker("w-a", a),
    worker("w-other-persona", b, randomUUID()),
  ];
  const ws = await workspaceOf(personaId, workers);

  expect(ws.repos.map((r) => ({ root: r.root, name: r.name, known: r.known, stale: r.stale }))).toEqual([
    { root: gone, name: "gone", known: true, stale: true },
    { root: a, name: "a", known: true, stale: false },
    { root: b, name: "b", known: false, stale: false },
  ]);
  expect(ws.repos[0]!.checkouts).toEqual([]);
  expect(ws.repos[1]!.checkouts.map((c) => ({ root: c.root, branch: c.branch, workers: c.workers.map((w) => w.id) }))).toEqual([
    { root: a, branch: "main", workers: ["w-a"] },
    { root: tree, branch: "feature", workers: ["w-tree"] },
  ]);
  expect(ws.repos[2]!.checkouts.map((c) => ({ root: c.root, branch: c.branch, workers: c.workers.map((w) => w.id) }))).toEqual([
    { root: b, branch: "trunk", workers: ["w-b"] },
  ]);
  expect(ws.contextFolder).toEqual({ path: contextFolder(), artifacts: [] });
});

test("artifacts are regular .html files directly at a checkout root and the context folder root", async () => {
  const a = await repoWithCommit(join(root, "a"));
  await writeFile(join(a, "report.html"), "<p>hi</p>");
  await writeFile(join(a, "Board.HTML"), "<p>hi</p>");
  await writeFile(join(a, "notes.txt"), "x");
  await mkdir(join(a, "dir.html"));
  await mkdir(join(a, "sub"));
  await writeFile(join(a, "sub", "deep.html"), "x");
  await writeFile(join(root, "outside.html"), "x");
  await symlink(join(root, "outside.html"), join(a, "link.html"));
  await seedContextFolder(contextFolder());
  await writeFile(join(contextFolder(), "plan.html"), "x");
  await writeFile(join(contextFolder(), "notes", "inner.html"), "x");

  const ws = await workspaceOf(personaId, [worker("w", a)]);
  expect(ws.repos).toHaveLength(1);
  expect(ws.repos[0]!.checkouts[0]!.artifacts).toEqual([
    { path: join(a, "Board.HTML"), name: "Board.HTML" },
    { path: join(a, "report.html"), name: "report.html" },
  ]);
  expect(ws.contextFolder.artifacts).toEqual([{ path: join(contextFolder(), "plan.html"), name: "plan.html" }]);
});

test("a known root that is not a git repository is one checkout with no branch; a worker whose folder is gone is still listed", async () => {
  const plain = join(root, "plain");
  await mkdir(plain);
  await seedContextFolder(contextFolder());
  await writeRepoBlockText(contextFolder(), plain);
  const vanished = join(root, "vanished");

  const ws = await workspaceOf(personaId, [worker("w-plain", plain), worker("w-gone", vanished)]);
  expect(ws.repos).toEqual([
    { root: plain, name: "plain", known: true, stale: false, checkouts: [{ root: plain, branch: null, workers: [expect.objectContaining({ id: "w-plain" })], artifacts: [] }] },
    { root: vanished, name: "vanished", known: false, stale: true, checkouts: [{ root: vanished, branch: null, workers: [expect.objectContaining({ id: "w-gone" })], artifacts: [] }] },
  ]);
});

test("each worker carries its latest report's text, or null", async () => {
  const a = await repoWithCommit(join(root, "a"));
  const report = (agentId: string, text: string): AgentReport => ({
    reportId: `${agentId}:r`, personaId, agentId, kind: text === "" ? "exited" : "ended", text, messageUnavailable: text === "",
    title: agentId, cwd: a, at: "2026-10-03T00:00:00.000Z",
  });
  const latest = new Map([["w-done", report("w-done", "done: build it\nsecond line")], ["w-exited", report("w-exited", "")]]);
  const ws = await workspaceOf(personaId, [worker("w-done", a), worker("w-exited", a), worker("w-new", a)], (id) => latest.get(id) ?? null);
  expect(ws.repos[0]!.checkouts[0]!.workers.map((w) => [w.id, w.latestReport])).toEqual([
    ["w-done", "done: build it\nsecond line"],
    ["w-exited", null],
    ["w-new", null],
  ]);
});

test("a context folder that does not exist yet lists nothing and is not an error", async () => {
  const ws = await workspaceOf(personaId, []);
  expect(ws).toEqual({ repos: [], contextFolder: { path: contextFolder(), artifacts: [] } });
});

test("refuses an id that is not a persona id", async () => {
  await expect(workspaceOf("../escape", [])).rejects.toThrow();
});
