import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type http from "node:http";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { seedContextFolder, writeRepoBlockText } from "../../src/server/context-folder";
import { allowedRoots, artifactHandler, listFolder, openInside, READ_CAP_BYTES, readTextFile, resolveInside } from "../../src/server/files";
import { createHttpServer } from "../../src/server/http";
import type { Worker } from "../../src/shared/types";

let root = "";
let home = "";
let checkout = "";
let known = "";
let savedHome: string | undefined;
let server: http.Server | null = null;
const personaId = randomUUID();

const contextFolder = (): string => join(home, ".cube", "personas", personaId);

function worker(cwd: string): Worker {
  return {
    id: randomUUID(), personaId, harness: "claude", cwd, title: "w", sessionId: null, launchId: randomUUID(), pid: null,
    cmdline: null, state: "idle", createdAt: "2026-10-03T00:00:00.000Z", lastReportId: null,
  };
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "personas-files-")));
  home = join(root, "home");
  checkout = join(root, "checkout");
  known = join(root, "known");
  await mkdir(home);
  await mkdir(checkout);
  await mkdir(known);
  execFileSync("git", ["init", "-q", checkout]);
  savedHome = process.env.HOME;
  process.env.HOME = home;
  await seedContextFolder(contextFolder());
  await writeRepoBlockText(contextFolder(), known);
});

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  await rm(root, { recursive: true, force: true });
});

describe("allowedRoots and resolveInside", () => {
  test("the known roots, the workers' checkout roots and the context folder", async () => {
    await mkdir(join(checkout, "src"));
    const roots = await allowedRoots(personaId, [worker(join(checkout, "src"))]);
    expect(roots.sort()).toEqual([known, checkout, contextFolder()].sort());
  });

  test("a worker folder outside any git checkout adds no root; one inside a checkout adds the checkout's root", async () => {
    const plain = join(root, "plain");
    await mkdir(join(plain, "deep"), { recursive: true });
    await mkdir(join(checkout, "src"));
    const roots = await allowedRoots(personaId, [worker(join(plain, "deep")), worker(plain), worker(join(checkout, "src")), worker(join(root, "gone"))]);
    expect(roots.sort()).toEqual([known, checkout, contextFolder()].sort());
  });

  test("the filesystem root and the home folder are never roots, even when listed or when home is a checkout", async () => {
    execFileSync("git", ["init", "-q", home]);
    await writeFile(join(home, ".bashrc"), "secret");
    await writeRepoBlockText(contextFolder(), `${known}\n/\n${home}`);
    const roots = await allowedRoots(personaId, [worker(home)]);
    expect(roots.sort()).toEqual([known, contextFolder()].sort());
    expect(await resolveInside(join(home, ".bashrc"), roots)).toBeNull();
  });

  test("a folder swapped for a symlink between the check and the open is refused; unswapped it opens", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "a.html"), "outside");
    await mkdir(join(checkout, "sub"));
    await writeFile(join(checkout, "sub", "a.html"), "inside");
    const path = join(checkout, "sub", "a.html");

    const fine = await openInside(path, [checkout]);
    expect(fine?.real).toBe(path);
    await fine!.handle.close();

    let swapped = false;
    const opened = await openInside(path, [checkout], {
      beforeOpen: async () => {
        await rename(join(checkout, "sub"), join(checkout, "sub-old"));
        await symlink(outside, join(checkout, "sub"));
        swapped = true;
      },
    });
    expect(swapped).toBe(true);
    expect(opened).toBeNull();
    // The path now leads outside: refused by the check itself as well.
    await expect(readTextFile(path, [checkout])).rejects.toThrow("That file is not available.");
  });

  test("a last component swapped for a symlink between the check and the open is refused", async () => {
    await writeFile(join(root, "secret.html"), "secret");
    await writeFile(join(checkout, "a.html"), "inside");
    const path = join(checkout, "a.html");
    const opened = await openInside(path, [checkout], {
      beforeOpen: async () => {
        await rm(path);
        await symlink(join(root, "secret.html"), path);
      },
    });
    expect(opened).toBeNull();
  });

  test("a path equal to or under a root resolves to its real path; anything else is null", async () => {
    await writeFile(join(checkout, "a.html"), "x");
    await writeFile(join(root, "secret.html"), "x");
    await symlink(join(root, "secret.html"), join(checkout, "out.html"));
    await symlink(join(checkout, "a.html"), join(known, "in.html"));
    const roots = [checkout, known];
    expect(await resolveInside(join(checkout, "a.html"), roots)).toBe(join(checkout, "a.html"));
    expect(await resolveInside(checkout, roots)).toBe(checkout);
    expect(await resolveInside(join(known, "in.html"), roots)).toBe(join(checkout, "a.html"));
    expect(await resolveInside(join(checkout, "out.html"), roots)).toBeNull();
    expect(await resolveInside(join(root, "secret.html"), roots)).toBeNull();
    expect(await resolveInside(`${checkout}/../secret.html`, roots)).toBeNull();
    // `..` is refused even when it would land back inside.
    expect(await resolveInside(`${checkout}/sub/../a.html`, roots)).toBeNull();
    expect(await resolveInside("a.html", roots)).toBeNull();
    expect(await resolveInside(join(checkout, "missing.html"), roots)).toBeNull();
    expect(await resolveInside(`${checkout}-other/a.html`, roots)).toBeNull();
    expect(await resolveInside(`${join(checkout, "a.html")}\0`, roots)).toBeNull();
    expect(await resolveInside(42, roots)).toBeNull();
  });
});

describe("GET /artifact", () => {
  async function serve(): Promise<number> {
    const handler = artifactHandler({
      exists: (id) => id === personaId,
      roots: (id) => allowedRoots(id, [worker(checkout)]),
    });
    server = createHttpServer({ extra: [["GET", "/artifact", handler]] });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    return (server.address() as AddressInfo).port;
  }

  const get = (port: number, path: string, persona: string = personaId): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}/artifact?persona=${encodeURIComponent(persona)}&path=${encodeURIComponent(path)}`);

  test("an .html file at a checkout root is served as HTML, never cached", async () => {
    await writeFile(join(checkout, "board.html"), "<h1>board</h1>");
    await writeFile(join(contextFolder(), "plan.html"), "<h1>plan</h1>");
    const port = await serve();
    const res = await get(port, join(checkout, "board.html"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("<h1>board</h1>");
    const plan = await get(port, join(contextFolder(), "plan.html"));
    expect(plan.status).toBe(200);
    expect(await plan.text()).toBe("<h1>plan</h1>");
  });

  test("`..` out, a symlink pointing outside, a path elsewhere, a .js file, a directory and an unknown persona are 404", async () => {
    await writeFile(join(checkout, "board.html"), "<h1>board</h1>");
    await writeFile(join(checkout, "app.js"), "alert(1)");
    await writeFile(join(root, "secret.html"), "secret");
    await symlink(join(root, "secret.html"), join(checkout, "link.html"));
    await symlink(join(checkout, "app.js"), join(checkout, "script.html"));
    await mkdir(join(checkout, "dir.html"));
    const port = await serve();
    const refused = [
      `${checkout}/../secret.html`,
      join(checkout, "link.html"),
      join(root, "secret.html"),
      join(checkout, "app.js"),
      join(checkout, "script.html"),
      join(checkout, "dir.html"),
      "board.html",
      join(checkout, "missing.html"),
    ];
    for (const path of refused) {
      const res = await get(port, path);
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
      expect(await res.text()).not.toContain("secret");
    }
    expect((await get(port, join(checkout, "board.html"), randomUUID())).status).toBe(404);
    expect((await get(port, join(checkout, "board.html"), "../x")).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/artifact?persona=${personaId}`)).status).toBe(404);
  });
});

describe("files:list and files:read", () => {
  test("lists a folder inside a root, directories first", async () => {
    await mkdir(join(contextFolder(), "notes", "deep"), { recursive: true });
    await writeFile(join(contextFolder(), "notes", "a.md"), "a");
    const roots = [contextFolder()];
    expect(await listFolder(contextFolder(), roots)).toEqual({
      entries: [{ name: "notes", dir: true }, { name: "AGENTS.md", dir: false }],
    });
    expect(await listFolder(join(contextFolder(), "notes"), roots)).toEqual({
      entries: [{ name: "deep", dir: true }, { name: "a.md", dir: false }],
    });
    await expect(listFolder(root, roots)).rejects.toThrow("That folder is not available.");
    await expect(listFolder(join(contextFolder(), "AGENTS.md"), roots)).rejects.toThrow("That folder is not available.");
  });

  test("reads a file inside a root; a 2 MiB file returns its first 1 MiB, truncated", async () => {
    await writeFile(join(checkout, "small.txt"), "hello");
    await writeFile(join(checkout, "big.txt"), "y".repeat(2 * 1024 * 1024));
    await writeFile(join(root, "secret.txt"), "secret");
    await symlink(join(root, "secret.txt"), join(checkout, "link.txt"));
    const roots = [checkout];
    expect(await readTextFile(join(checkout, "small.txt"), roots)).toEqual({ text: "hello", truncated: false });
    const big = await readTextFile(join(checkout, "big.txt"), roots);
    expect(READ_CAP_BYTES).toBe(1024 * 1024);
    expect(big.truncated).toBe(true);
    expect(Buffer.byteLength(big.text)).toBe(1024 * 1024);
    await expect(readTextFile(join(checkout, "link.txt"), roots)).rejects.toThrow("That file is not available.");
    await expect(readTextFile(`${checkout}/../secret.txt`, roots)).rejects.toThrow("That file is not available.");
    await expect(readTextFile(checkout, roots)).rejects.toThrow("That file is not available.");
  });

  test("a truncated read never ends inside a UTF-8 sequence", async () => {
    // One ASCII byte, then 3-byte characters: the 1 MiB cut lands inside one.
    await writeFile(join(checkout, "wide.txt"), `a${"€".repeat(400_000)}`);
    const read = await readTextFile(join(checkout, "wide.txt"), [checkout]);
    expect(read.truncated).toBe(true);
    expect(read.text.endsWith("€")).toBe(true);
    expect(read.text).not.toContain("�");
  });
});
