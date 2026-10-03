import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { writeRepoBlockText } from "../../src/server/context-folder";
import { listRepos } from "../../src/server/repos";

let root = "";
let home = "";
let context = "";

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "personas-repos-")));
  home = join(root, "home");
  context = join(home, ".cube", "personas", "p-1");
  await mkdir(join(home, "repos"), { recursive: true });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function gitDir(dir: string): Promise<string> {
  await mkdir(join(dir, ".git"), { recursive: true });
  return dir;
}

test("lists git repositories one level under ~/repos and skips other directories", async () => {
  const a = await gitDir(join(home, "repos", "a"));
  const b = join(home, "repos", "b");
  await mkdir(b);
  await writeFile(join(b, ".git"), "gitdir: /elsewhere/.git/worktrees/b\n");
  await mkdir(join(home, "repos", "plain"));
  await writeFile(join(home, "repos", "notes.txt"), "x");
  await gitDir(join(home, "repos", "plain", "nested"));
  expect(await listRepos(home, context)).toEqual([
    { path: a, name: "a", known: false },
    { path: b, name: "b", known: false },
  ]);
});

test("a missing ~/repos lists only the known roots", async () => {
  await rm(join(home, "repos"), { recursive: true });
  expect(await listRepos(home, context)).toEqual([]);
});

test("known roots come first in file order, including ones outside ~/repos", async () => {
  const a = await gitDir(join(home, "repos", "a"));
  const z = await gitDir(join(home, "repos", "z"));
  const outside = await gitDir(join(root, "work", "outside"));
  await writeRepoBlockText(context, `${outside}\n${z}`);
  expect(await listRepos(home, context)).toEqual([
    { path: outside, name: "outside", known: true },
    { path: z, name: "z", known: true },
    { path: a, name: "a", known: false },
  ]);
});

test("a repository reached through a symlink is listed once", async () => {
  const a = await gitDir(join(home, "repos", "a"));
  await symlink(a, join(home, "repos", "alias"));
  const elsewhere = await gitDir(join(root, "work", "real"));
  await symlink(elsewhere, join(home, "repos", "linked"));
  await writeRepoBlockText(context, join(home, "repos", "alias"));
  expect(await listRepos(home, context)).toEqual([
    { path: join(home, "repos", "alias"), name: "alias", known: true },
    { path: join(home, "repos", "linked"), name: "linked", known: false },
  ]);
});
