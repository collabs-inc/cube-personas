import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { crashHandler } from "../../src/server/crash";
import { ProcessManager } from "../../src/server/processes";

const MARK = `62.${process.pid}${Math.floor(Math.random() * 1e6)}`;
const managers: ProcessManager[] = [];

function alive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
  } catch {
    return false;
  }
}

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.killAll()));
});

test("an uncaught error logs, sends SIGTERM to every live child group at once, and exits 1, once", async () => {
  const pm = new ProcessManager();
  managers.push(pm);
  const pipe = pm.spawnPipe({ command: "sleep", args: [MARK], cwd: process.cwd(), env: process.env });
  const term = pm.spawnPty({ command: "sleep", args: [MARK], cwd: process.cwd(), env: process.env, cols: 80, rows: 24 });
  const kill = vi.spyOn(process, "kill");
  const logs: string[] = [];
  const exit = vi.fn();
  try {
    const crash = crashHandler(pm, (l) => logs.push(l), exit);
    crash(new Error("disk full"));
    crash(new Error("again"));
    const terms = kill.mock.calls.filter(([, sig]) => sig === "SIGTERM").map(([target]) => target);
    expect(terms.sort()).toEqual([-pipe.pid, -term.pid].sort());
  } finally {
    kill.mockRestore();
  }
  expect(exit.mock.calls).toEqual([[1]]);
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("disk full");
  expect(await until(() => !alive(pipe.pid) && !alive(term.pid), 3000)).toBe(true);
});
