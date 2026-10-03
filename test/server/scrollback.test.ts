import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Scrollback } from "../../src/server/scrollback";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "personas-scrollback-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("Scrollback", () => {
  test("defaults to a 256 KiB cap and keeps the trailing bytes", async () => {
    const big = new Scrollback(join(dir, "big"));
    big.push("x".repeat(300_000) + "END");
    expect(Buffer.byteLength(big.text())).toBe(262144);
    expect(big.text().endsWith("END")).toBe(true);
    await big.flush();

    const sb = new Scrollback(join(dir, "w"), 10);
    sb.push("abcdef");
    sb.push("ghijkl");
    expect(sb.text()).toBe("cdefghijkl");
    await sb.flush();
  });

  test("a 4-byte emoji at the cut is dropped whole, never split", async () => {
    const sb = new Scrollback(join(dir, "w"), 6);
    // "a" + 😀 (4 bytes) + "bcd" = 8 bytes; the trailing 6 start inside the emoji.
    sb.push("a\u{1F600}bcd");
    expect(sb.text()).toBe("bcd");
    expect(sb.text()).not.toContain("�");
    const fits = new Scrollback(join(dir, "v"), 7);
    fits.push("a\u{1F600}bcd");
    expect(fits.text()).toBe("\u{1F600}bcd");
    await sb.flush();
    await fits.flush();
  });

  test("flush() writes the text, and load() restores it in a fresh instance", async () => {
    const path = join(dir, "worker.log");
    const sb = new Scrollback(path, 32);
    sb.push("hello ");
    sb.push("world \u{1F600}");
    await sb.flush();
    expect(readFileSync(path, "utf8")).toBe(sb.text());
    const again = new Scrollback(path, 32);
    await again.load();
    expect(again.text()).toBe(sb.text());
    again.push("!");
    expect(again.text()).toBe(sb.text() + "!");
    await again.flush();
  });

  test("load() of a missing file starts empty", async () => {
    const sb = new Scrollback(join(dir, "none"));
    await sb.load();
    expect(sb.text()).toBe("");
  });

  test("data that arrives is flushed within about a second without an explicit flush()", async () => {
    const path = join(dir, "auto");
    const sb = new Scrollback(path, 1024);
    sb.push("one");
    expect(existsSync(path)).toBe(false);
    await new Promise((r) => setTimeout(r, 1300));
    expect(readFileSync(path, "utf8")).toBe("one");
    await sb.flush();
  });
});
