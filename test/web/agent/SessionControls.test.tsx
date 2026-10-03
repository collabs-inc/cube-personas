// Adapted from cube-computer: src/windows/app/src/items/agent/SessionControls.test.tsx
// @vitest-environment happy-dom
import { afterAll, afterEach, expect, test } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { SessionControls } from "../../../src/web/agent/SessionControls";
import { EMPTY_TRANSCRIPT } from "../../../src/web/agent/transcript";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | null = null;
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });
test("panel presentation exposes model and extra settings without a nested disclosure", async () => {
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<SessionControls presentation="panel" transcript={{ ...EMPTY_TRANSCRIPT,
    configOptions: [
      { id: "model", name: "Model", category: "model", type: "select", currentValue: "one", options: [{ value: "one", name: "Model One" }] },
      { id: "fast", name: "Fast mode", type: "boolean", currentValue: true },
    ],
  }} disabled={false} onConfig={async () => {}} onMode={() => {}} onModel={() => {}} />));
  expect(container.querySelector('select[aria-label="Model"]')).not.toBeNull();
  expect(container.querySelector<HTMLInputElement>('[aria-label="Fast mode"]')?.checked).toBe(true);
  expect(container.querySelector("details")).toBeNull();
});
test("advertised config replaces legacy controls and grouped model choices send exact values", async () => {
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  const chosen: unknown[] = [];
  await act(async () => root!.render(<SessionControls transcript={{ ...EMPTY_TRANSCRIPT,
    configOptions: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "one", options: [{ group: "provider", name: "Provider", options: [{ value: "one", name: "Model One" }, { value: "two", name: "Model Two" }] }] }],
    modes: { current: "old", available: [{ id: "old", name: "Legacy mode" }] },
  }} disabled={false} onConfig={async (id, value) => { chosen.push([id, value]); }} onMode={() => {}} onModel={() => {}} />));
  const select = container.querySelector("select")!;
  expect(select.querySelector("optgroup")?.label).toBe("Provider");
  expect(container.textContent).not.toContain("Legacy mode");
  await act(async () => { select.value = "two"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(chosen).toEqual([["model", "two"]]);
});

test("boolean settings await acknowledgement and recover from rejected transport", async () => {
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  const transcript = { ...EMPTY_TRANSCRIPT, configOptions: [{ id: "fast", name: "Fast mode", type: "boolean" as const, currentValue: false }] };
  let reject: (reason: Error) => void = () => {};
  const requests: unknown[] = [];
  await act(async () => root!.render(<SessionControls transcript={transcript} disabled={false}
    onConfig={(id, value) => { requests.push([id, value]); return new Promise((_resolve, fail) => { reject = fail; }); }} onMode={() => {}} onModel={() => {}} />));
  const control = container.querySelector<HTMLInputElement>('input[role="switch"]')!;
  await act(async () => control.click());
  expect(requests).toEqual([["fast", true]]);
  expect(control.checked).toBe(false);
  expect(control.disabled).toBe(true);
  await act(async () => reject(new Error("Connection lost")));
  expect(control.disabled).toBe(false);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Connection lost");
  await act(async () => root!.render(<SessionControls transcript={{ ...transcript, configOptions: [{ ...transcript.configOptions[0]!, currentValue: true }] }} disabled={false}
    onConfig={async () => {}} onMode={() => {}} onModel={() => {}} />));
  expect(control.checked).toBe(true);
});

test("legacy mode controls remain locked while the matching ACP request is pending", async () => {
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<SessionControls transcript={{ ...EMPTY_TRANSCRIPT,
    modes: { current: "default", available: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }] },
    controlRequests: [{ requestId: "mode-1", method: "session/set_mode", configId: null, value: "plan" }],
  }} disabled={false} onConfig={async () => {}} onMode={() => {}} onModel={() => {}} />));
  expect(container.querySelector<HTMLSelectElement>('select[aria-label="Mode"]')!.disabled).toBe(true);
});
