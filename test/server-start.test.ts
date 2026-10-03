import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { connect, createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const root = join(import.meta.dirname, "..");
let child: ChildProcess | undefined;
let stateTmp: string;
let port: number;

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
  }
  return newest;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
    s.on("error", reject);
  });
}

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.status === 200) return;
    } catch {}
    if (Date.now() > deadline) throw new Error("server did not answer /health in 10 s");
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  const bundle = join(root, "dist", "server.js");
  const fresh = existsSync(bundle) && existsSync(join(root, "dist", "web", "index.html")) && statSync(bundle).mtimeMs > newestMtime(join(root, "src"));
  if (!fresh) execFileSync("npm", ["run", "build"], { cwd: root, stdio: "pipe" });
  stateTmp = mkdtempSync(join(tmpdir(), "personas-state-"));
  port = await freePort();
  child = spawn("node", ["dist/server.js"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), PERSONAS_STATE_DIR: stateTmp },
    stdio: "ignore",
  });
  await waitForHealth();
}, 120_000);

function killChild(): void {
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

afterAll(() => {
  killChild();
  rmSync(stateTmp, { recursive: true, force: true });
});

test("GET /health answers ok", async () => {
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  expect(await res.json()).toEqual({ ok: true });
});

test("GET / serves the page", async () => {
  const res = await fetch(`http://127.0.0.1:${port}/`);
  expect(res.headers.get("content-type")).toContain("text/html");
  expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
  expect(await res.text()).toContain('<div id="root">');
});

test("listens only on 127.0.0.1", async () => {
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  expect(res.status).toBe(200);
  const external = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === "IPv4" && !i.internal);
  if (!external) return; // no non-loopback address on this machine: nothing to probe
  const outcome = await new Promise<"connected" | "refused">((resolve) => {
    const sock = connect({ host: external.address, port, timeout: 3000 });
    sock.once("connect", () => { sock.destroy(); resolve("connected"); });
    sock.once("error", () => { sock.destroy(); resolve("refused"); });
    sock.once("timeout", () => { sock.destroy(); resolve("refused"); });
  });
  expect(outcome).toBe("refused");
});

test("a second server on the same state folder exits 1 with one sentence, leaving the first running", async () => {
  const other = await freePort();
  const second = spawn("node", ["dist/server.js"], {
    cwd: root,
    env: { ...process.env, PORT: String(other), PERSONAS_STATE_DIR: stateTmp },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  second.stderr!.on("data", (d) => (stderr += d));
  const code = await Promise.race([
    new Promise<number | null>((resolve) => second.once("exit", (c) => resolve(c))),
    new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 10_000)),
  ]);
  if (code === "timeout") second.kill("SIGKILL");
  expect(code).toBe(1);
  expect(stderr.trim()).toBe("Another Personas server is using this state folder.");
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  expect(res.status).toBe(200);
}, 15_000);

test("exits on SIGTERM within 5 s", async () => {
  const exited = new Promise<number | null>((resolve) => child!.once("exit", (code) => resolve(code)));
  child!.kill("SIGTERM");
  const code = await Promise.race([exited, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 5000))]);
  if (code === "timeout") killChild();
  expect(code).toBe(0);
});
