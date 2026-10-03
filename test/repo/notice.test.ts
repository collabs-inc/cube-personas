// NOTICE.md lists exactly the origins the adapted files' headers name.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const SKIP = new Set(["node_modules", "dist", ".git"]);
const MARK = ["Adapted", "from", "cube-computer:"].join(" ");

function files(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...files(path));
    else if (entry.isFile() && entry.name !== "NOTICE.md" && entry.name !== "package-lock.json") out.push(path);
  }
  return out;
}

/** Each header's origin: the rest of its line, without a closing comment marker. */
function headerOrigins(): Map<string, string[]> {
  const origins = new Map<string, string[]>();
  for (const file of files(ROOT)) {
    const text = readFileSync(file, "utf8");
    for (const line of text.split("\n").slice(0, 3)) {
      const at = line.indexOf(MARK);
      if (at < 0) continue;
      const origin = line.slice(at + MARK.length).replace(/\s*(\*\/|-->)\s*$/, "").trim();
      origins.set(origin, [...(origins.get(origin) ?? []), relative(ROOT, file)]);
    }
  }
  return origins;
}

function noticeOrigins(): string[] {
  return readFileSync(join(ROOT, "NOTICE.md"), "utf8").split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim());
}

test("every adaptation header's origin is listed in NOTICE.md", () => {
  const listed = new Set(noticeOrigins());
  const missing = [...headerOrigins()].filter(([origin]) => !listed.has(origin)).map(([origin, inFiles]) => `${origin} (${inFiles.join(", ")})`);
  expect(missing).toEqual([]);
});

test("NOTICE.md lists nothing that no header names, and nothing twice", () => {
  const origins = headerOrigins();
  const listed = noticeOrigins();
  expect(listed.filter((origin) => !origins.has(origin))).toEqual([]);
  expect(listed.length).toBe(new Set(listed).size);
});

test("an adaptation header is the file's first comment line (after a shebang)", () => {
  const late: string[] = [];
  for (const file of files(ROOT)) {
    const lines = readFileSync(file, "utf8").split("\n");
    const at = lines.findIndex((l) => l.includes(MARK));
    if (at < 0) continue;
    const allowed = lines[0]!.startsWith("#!") ? 1 : 0;
    if (at !== allowed) late.push(relative(ROOT, file));
  }
  expect(late).toEqual([]);
});
