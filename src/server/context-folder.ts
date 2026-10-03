// Adapted from cube-computer: src/main/cubed/personas/context-folder.ts
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertAbsolutePaths, parseRepoBlock, writeRepoBlock } from "./repo-block";

const PREAMBLE = `# Persona context

This folder is your working directory and your memory. Personas created it for you.

- Keep durable notes in \`notes/\`. They survive restarts and new conversations.
- The Repositories list below is the set of repositories you know about. Add or remove
  lines (one absolute checkout root each) when the user's work moves. Personas and the
  persona menu edit the same list.
- Everything outside the Repositories list is yours and the user's to edit freely.
`;

async function writeIfAbsent(file: string, text: string): Promise<void> {
  try { await writeFile(file, text, { flag: "wx", mode: 0o644 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
}

/** Creates `AGENTS.md` and an empty `notes/`, never overwriting what exists. */
export async function seedContextFolder(dir: string): Promise<void> {
  await mkdir(join(dir, "notes"), { recursive: true });
  await writeIfAbsent(join(dir, "AGENTS.md"), writeRepoBlock(PREAMBLE, []));
}

export async function readKnownRoots(dir: string): Promise<string[]> {
  try { return parseRepoBlock(await readFile(join(dir, "AGENTS.md"), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** The known roots as editable text, one path per line. */
export async function readRepoBlockText(dir: string): Promise<string> {
  return (await readKnownRoots(dir)).join("\n");
}

/** Replaces the block's entries with the absolute paths in `text`; every other byte survives. */
export async function writeRepoBlockText(dir: string, text: string): Promise<void> {
  const paths = text.split(/\r\n|\r|\n/).map(line => line.trim()).filter(Boolean);
  if (paths.some(path => !path.startsWith("/"))) throw new Error("Each line must be an absolute path.");
  assertAbsolutePaths(paths);
  // A persona may predate context-folder seeding. Preserve existing notes.
  await seedContextFolder(dir);
  const file = join(dir, "AGENTS.md");
  let current = "";
  try { current = await readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, writeRepoBlock(current, paths), { mode: 0o644 });
    await rename(tmp, file);
  } finally { await rm(tmp, { force: true }); }
}
