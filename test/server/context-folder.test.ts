// Adapted from cube-computer: src/main/cubed/personas/context-folder.test.ts
import { afterEach, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readKnownRoots, readRepoBlockText, seedContextFolder, writeRepoBlockText,
} from "../../src/server/context-folder";

let base = "";
afterEach(async () => { if (base) await rm(base, { recursive: true, force: true }); });
const fresh = async () => (base = await mkdtemp(join(tmpdir(), "persona-ctx-")));

test("seeding writes AGENTS.md naming Personas and an empty notes/", async () => {
  const dir = join(await fresh(), "p1");
  await seedContextFolder(dir);
  const agents = await readFile(join(dir, "AGENTS.md"), "utf8");
  expect(agents).toContain("notes/");
  expect(agents).toContain("Personas");
  expect(agents).not.toContain("Cube created");
  expect(await readKnownRoots(dir)).toEqual([]);
  expect((await stat(join(dir, "notes"))).isDirectory()).toBe(true);
  expect(await readdir(join(dir, "notes"))).toEqual([]);
});

test("seeding never overwrites an existing AGENTS.md", async () => {
  const dir = join(await fresh(), "p2");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "AGENTS.md"), "mine\n");
  await seedContextFolder(dir);
  expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe("mine\n");
});

test("writeRepoBlockText initializes a missing context folder", async () => {
  const dir = join(await fresh(), "missing", "persona");
  await writeRepoBlockText(dir, "/r/site");
  expect(await readRepoBlockText(dir)).toBe("/r/site");
  expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toContain("# Persona context");
  expect((await stat(join(dir, "notes"))).isDirectory()).toBe(true);
});

test("writeRepoBlockText rewrites only the block; missing file reads empty", async () => {
  const dir = join(await fresh(), "p3");
  expect(await readRepoBlockText(dir)).toBe("");
  await seedContextFolder(dir);
  const file = join(dir, "AGENTS.md");
  const original = await readFile(file, "utf8") + "\n## User notes\nKeep this.\n";
  await writeFile(file, original);
  await writeRepoBlockText(dir, "/r/b\n\n  /r/c  \n");
  expect(await readRepoBlockText(dir)).toBe("/r/b\n/r/c");
  const updated = await readFile(file, "utf8");
  expect(updated.replace("- /r/b\n- /r/c\n", "")).toBe(original);
  await expect(writeRepoBlockText(dir, "/r/ok\nrel")).rejects.toThrow("Each line must be an absolute path.");
  expect(await readFile(file, "utf8")).toBe(updated);
  expect((await readdir(dir)).sort()).toEqual(["AGENTS.md", "notes"]);
});
