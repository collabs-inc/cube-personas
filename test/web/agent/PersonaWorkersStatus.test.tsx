// Adapted from cube-computer: src/windows/app/src/persona/PersonaWorkersStatus.test.tsx
// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Worker } from "../../../src/shared/types";
import { PersonaWorkersStatus } from "../../../src/web/agent/PersonaWorkersStatus";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
async function render(node: ReactNode) {
  await act(async () => { root.render(node); });
}
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

const worker = (id: string, state: Worker["state"]): Worker => ({
  id, personaId: "p1", harness: "claude", cwd: "/repo", title: id, sessionId: null, launchId: "l",
  pid: null, cmdline: null, state, createdAt: "t", lastReportId: null,
});

test("the line names the running count", async () => {
  await render(<PersonaWorkersStatus workers={[worker("a", "running"), worker("b", "running"), worker("c", "idle")]} />);
  expect(container.querySelector(".persona-workers-status")?.textContent).toBe("2 workers running");
  await render(<PersonaWorkersStatus workers={[worker("a", "running")]} />);
  expect(container.querySelector(".persona-workers-status")?.textContent).toBe("1 worker running");
});

test("nothing renders when no worker is running", async () => {
  await render(<PersonaWorkersStatus workers={[]} />);
  expect(container.querySelector(".persona-workers-status")).toBeNull();
  await render(<PersonaWorkersStatus workers={[worker("idle", "idle"), worker("gone", "exited")]} />);
  expect(container.querySelector(".persona-workers-status")).toBeNull();
});
